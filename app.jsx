import React, { useRef, useState } from "react";

/**
 * Universal NPSF converter (images, audio, video).
 * - Images -> 8-bit RGBA frames (ImageData)
 * - Audio  -> Float32 PCM interleaved (preserves decoded floats)
 * - Video  -> sequence of 8-bit RGBA frames captured from a <video> (requestVideoFrameCallback when available)
 *
 * Container:
 * - Magic: "NPSF\x01"
 * - Header length (u32BE) + JSON header
 * - Chunks: each chunk = 4-byte ASCII type + u32BE(len) + data + u32BE(crc32(type+data))
 *   - IMAG -> image raster (single image) (RGBA 8-bit)
 *   - AUDI -> audio PCM (f32 interleaved)
 *   - VIDF -> video frame blob (RGBA 8-bit) per frame (each VIDF chunk contains exactly one frame's raw pixels)
 *   - ORIG -> original file bytes (optional)
 *   - END! -> empty terminal chunk
 *
 * Drop-in; keeps a hidden canvas for pixel extraction.
 */

export default function NpsfConverterUniversal() {
  const fileRef = useRef(null);
  const canvasRef = useRef(null);
  const videoRef = useRef(null);
  const [status, setStatus] = useState("");
  const [embedOriginal, setEmbedOriginal] = useState(true);
  const MAGIC = new Uint8Array([0x4E, 0x50, 0x53, 0x46, 0x01]); // 'NPSF\x01'

  // helpers
  function u32BE(n) {
    const b = new Uint8Array(4);
    b[0] = (n >>> 24) & 0xff;
    b[1] = (n >>> 16) & 0xff;
    b[2] = (n >>> 8) & 0xff;
    b[3] = (n >>> 0) & 0xff;
    return b;
  }

  // CRC32 table-based
  function crc32(buf) {
    if (!crc32.table) {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
          if (c & 1) c = 0xedb88320 ^ (c >>> 1);
          else c = c >>> 1;
        }
        t[i] = c >>> 0;
      }
      crc32.table = t;
    }
    const table = crc32.table;
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (~c) >>> 0;
  }

  function makeChunk(typeStr, dataUint8) {
    const typeBytes = new TextEncoder().encode(typeStr);
    const lenBytes = u32BE(dataUint8.length);
    const chunk = new Uint8Array(4 + 4 + dataUint8.length + 4);
    chunk.set(typeBytes, 0);
    chunk.set(lenBytes, 4);
    chunk.set(dataUint8, 8);
    const crcInput = new Uint8Array(typeBytes.length + dataUint8.length);
    crcInput.set(typeBytes, 0);
    crcInput.set(dataUint8, typeBytes.length);
    const crc = crc32(crcInput);
    chunk.set(u32BE(crc), 8 + dataUint8.length);
    return chunk;
  }

  function concatParts(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return out;
  }

  // Convert Float32Array planar->interleaved or keep interleaved if already interleaved
  function interleaveChannels(channelData) {
    // channelData: array of Float32Array, length = channels
    const channels = channelData.length;
    const len = channelData[0].length;
    const out = new Float32Array(len * channels);
    let idx = 0;
    for (let i = 0; i < len; i++) {
      for (let c = 0; c < channels; c++) {
        out[idx++] = channelData[c][i];
      }
    }
    return out;
  }

  // IMAGE: get ImageData from file using createImageBitmap and canvas
  async function extractImageRGBA(file) {
    const imgBitmap = await createImageBitmap(file);
    const w = imgBitmap.width;
    const h = imgBitmap.height;
    const canvas = canvasRef.current;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(imgBitmap, 0, 0, w, h);
    const im = ctx.getImageData(0, 0, w, h);
    // image data is Uint8ClampedArray - copy to plain Uint8Array
    const pixels = new Uint8Array(im.data.buffer.slice(0));
    return { width: w, height: h, pixels };
  }

  // AUDIO: decode via AudioContext and return interleaved Float32Array
  async function extractAudioPCM(file) {
    const ab = await file.arrayBuffer();
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    // decodeAudioData on some browsers expects a Promise-based call
    const audioBuffer = await audioCtx.decodeAudioData(ab.slice(0));
    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    // gather channel data
    const channelData = [];
    for (let c = 0; c < channels; c++) {
      channelData.push(audioBuffer.getChannelData(c));
    }
    const interleaved = interleaveChannels(channelData);
    // Float32Array -> Uint8Array view (little-endian IEEE-754)
    const bytes = new Uint8Array(interleaved.buffer.slice(0));
    return {
      sampleRate,
      channels,
      frames: audioBuffer.length,
      pcm_f32_bytes: bytes
    };
  }

  // VIDEO: capture frames (RGBA 8-bit) using requestVideoFrameCallback when available, otherwise timed capture.
  async function extractVideoFrames(file, onProgress = () => {}) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      videoRef.current = video;
      video.src = url;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.preload = "auto";

      const canvas = canvasRef.current;
      let ctx;

      function cleanup() {
        try {
          video.pause();
        } catch (e) {}
        video.src = "";
        URL.revokeObjectURL(url);
      }

      video.addEventListener("loadedmetadata", () => {
        const w = video.videoWidth;
        const h = video.videoHeight;
        const duration = video.duration;
        canvas.width = w;
        canvas.height = h;
        ctx = canvas.getContext("2d");

        // Try to estimate FPS: browsers don't give it reliably. We'll prefer to use requestVideoFrameCallback which provides timestamps.
        const frames = [];
        let frameCount = 0;
        let lastTimestamp = null;
        let stopped = false;

        // handler when finished
        function finish() {
          stopped = true;
          cleanup();
          resolve({
            width: w,
            height: h,
            frames: frames, // array of Uint8Array per frame (RGBA)
            duration
          });
        }

        // Use requestVideoFrameCallback if available
        if (video.requestVideoFrameCallback) {
          video.play().catch(() => {
            // some browsers require interaction; try play anyway
          });
          const cb = (now, metadata) => {
            if (stopped) return;
            try {
              ctx.drawImage(video, 0, 0, w, h);
              const im = ctx.getImageData(0, 0, w, h);
              frames.push(new Uint8Array(im.data.buffer.slice(0)));
              frameCount++;
              onProgress(frameCount);
            } catch (err) {
              // drawing issues
            }
            if (video.ended || (metadata && metadata.presentedFrames && metadata.presentedFrames >= 1 && video.currentTime >= video.duration)) {
              finish();
              return;
            }
            // continue
            video.requestVideoFrameCallback(cb);
          };
          // first schedule
          video.requestVideoFrameCallback(cb);
          // also listen for ended
          video.addEventListener("ended", () => {
            if (!stopped) finish();
          });
        } else {
          // Fallback: play video and use setTimeout capturing at an estimated frame rate (attempt 30fps)
          const estFps = 30;
          const interval = 1000 / estFps;
          video.play().catch(() => {});
          let t = 0;
          function tick() {
            if (video.ended || stopped) {
              finish();
              return;
            }
            try {
              ctx.drawImage(video, 0, 0, w, h);
              const im = ctx.getImageData(0, 0, w, h);
              frames.push(new Uint8Array(im.data.buffer.slice(0)));
              frameCount++;
              onProgress(frameCount);
            } catch (err) {
              // ignore draw errors
            }
            setTimeout(tick, interval);
          }
          tick();
          video.addEventListener("ended", () => {
            if (!stopped) finish();
          });
        }
      });

      video.addEventListener("error", (e) => {
        cleanup();
        reject(new Error("Failed to load video for decoding"));
      });
    });
  }

  // Build the universal NPSF given a typed payload description
  async function buildNpsfUniversal({ headerJson, chunks }) {
    const headerUtf8 = new TextEncoder().encode(JSON.stringify(headerJson));
    const parts = [];
    parts.push(MAGIC);
    parts.push(u32BE(headerUtf8.length));
    parts.push(headerUtf8);

    for (const ch of chunks) {
      // ch = { type: 'IMAG'|'AUDI'|'VIDF'|'ORIG', data: Uint8Array }
      parts.push(makeChunk(ch.type, ch.data));
    }

    // END! chunk
    parts.push(makeChunk("END!", new Uint8Array(0)));

    const out = concatParts(parts);
    return out.buffer;
  }

  // Top-level handler
  async function handleFile(e) {
    setStatus("");
    const file = e.target.files ? e.target.files[0] : e;
    if (!file) return;
    setStatus(`Preparing to decode ${file.name}...`);

    // Optionally embed original bytes
    let origBytes = null;
    if (embedOriginal) {
      setStatus("Reading original bytes...");
      origBytes = new Uint8Array(await file.arrayBuffer());
    }

    // Detect media type by file.type primary or by extension fallback
    const mime = file.type || "";
    const ext = (file.name.match(/\.[^.]+$/) || [""])[0].toLowerCase();
    let kind = "binary";
    if (mime.startsWith("image/") || [".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif"].includes(ext)) kind = "image";
    else if (mime.startsWith("audio/") || [".mp3", ".wav", ".flac", ".ogg", ".m4a"].includes(ext)) kind = "audio";
    else if (mime.startsWith("video/") || [".mp4", ".webm", ".mov", ".mkv"].includes(ext)) kind = "video";

    try {
      if (kind === "image") {
        setStatus("Decoding image to RGBA...");
        const { width, height, pixels } = await extractImageRGBA(file);
        const header = {
          media_type: "image",
          width,
          height,
          channels: 4,
          channel_order: "RGBA",
          bit_depth: 8,
          color_space: "sRGB (browser-decoded)",
          compression: "none",
          embed_original: !!origBytes
        };
        const chunks = [{ type: "IMAG", data: pixels }];
        if (origBytes) chunks.push({ type: "ORIG", data: origBytes });
        setStatus("Building NPSF...");
        const npsfBuffer = await buildNpsfUniversal({ headerJson: header, chunks });
        downloadBuffer(npsfBuffer, file.name.replace(/\.[^.]+$/, "") + ".npsf");
        setStatus("Done — downloaded image .npsf (pixels from browser decoding).");
      } else if (kind === "audio") {
        setStatus("Decoding audio to PCM (Float32)...");
        const { sampleRate, channels, frames, pcm_f32_bytes } = await extractAudioPCM(file);
        const header = {
          media_type: "audio",
          subtype: "pcm_f32",
          sample_rate: sampleRate,
          channels,
          frames,
          bit_depth: 32,
          sample_endianness: "little",
          compression: "none",
          embed_original: !!origBytes
        };
        const chunks = [{ type: "AUDI", data: pcm_f32_bytes }];
        if (origBytes) chunks.push({ type: "ORIG", data: origBytes });
        setStatus("Building NPSF...");
        const npsfBuffer = await buildNpsfUniversal({ headerJson: header, chunks });
        downloadBuffer(npsfBuffer, file.name.replace(/\.[^.]+$/, "") + ".npsf");
        setStatus("Done — downloaded audio .npsf (Float32 PCM).");
      } else if (kind === "video") {
        setStatus("Decoding video frames (this may take a while)...");
        const framesResult = await extractVideoFrames(file, (fcount) => {
          setStatus(`Captured ${fcount} frames...`);
        });
        const { width, height, frames, duration } = framesResult;
        // Prepare chunks: one VIDF chunk per frame
        const header = {
          media_type: "video",
          width,
          height,
          pixel_format: "RGBA",
          bit_depth: 8,
          frames: frames.length,
          duration,
          compression: "none",
          embed_original: !!origBytes
        };
        const chunks = [];
        // Add frame chunks (VIDF)
        for (let i = 0; i < frames.length; i++) {
          // Each frames[i] is Uint8Array of RGBA pixels
          chunks.push({ type: "VIDF", data: frames[i] });
        }
        if (origBytes) chunks.push({ type: "ORIG", data: origBytes });
        setStatus("Building NPSF (video) — assembling frames...");
        const npsfBuffer = await buildNpsfUniversal({ headerJson: header, chunks });
        downloadBuffer(npsfBuffer, file.name.replace(/\.[^.]+$/, "") + ".npsf");
        setStatus("Done — downloaded video .npsf with RGBA frames.");
      } else {
        // Unknown/binary: just wrap the binary file into ORIG and a BLOB chunk
        setStatus("Unknown type — wrapping as generic binary...");
        const orig = new Uint8Array(await file.arrayBuffer());
        const header = {
          media_type: "binary",
          size: orig.length,
          embed_original: !!origBytes
        };
        const chunks = [{ type: "BLOB", data: orig }];
        if (origBytes) chunks.push({ type: "ORIG", data: origBytes });
        const npsfBuffer = await buildNpsfUniversal({ headerJson: header, chunks });
        downloadBuffer(npsfBuffer, file.name.replace(/\.[^.]+$/, "") + ".npsf");
        setStatus("Done — downloaded generic .npsf containing binary blob.");
      }
    } catch (err) {
      console.error(err);
      setStatus("Error: " + String(err));
    }
  }

  function downloadBuffer(arrayBuffer, filename) {
    const blob = new Blob([arrayBuffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-6 max-w-3xl mx-auto font-sans">
      <h1 className="text-2xl font-bold mb-3">NPSF Universal — Image / Audio / Video</h1>
      <p className="mb-4">Upload an image, audio, or video file and this tool will decode it in-browser into raw decoded samples and pack them into a single .npsf container. Enable "Embed original" to include the original file bytes verbatim (useful for true lossless archival).</p>

      <label className="block mb-2">Select media to convert</label>
      <input ref={fileRef} type="file" accept="image/*,audio/*,video/*,*/*" onChange={handleFile} className="mb-3" />

      <label className="flex items-center gap-2 mb-3">
        <input type="checkbox" checked={embedOriginal} onChange={(ev) => setEmbedOriginal(ev.target.checked)} />
        <span>Embed original file inside .npsf (ORIG chunk)</span>
      </label>

      <div className="mb-4">
        <button onClick={() => fileRef.current && fileRef.current.click()} className="px-4 py-2 bg-slate-800 text-white rounded">Choose file</button>
      </div>

      <div className="mb-4 text-sm text-slate-600">{status}</div>

      {/* Hidden canvas used for image and video pixel extraction */}
      <canvas ref={canvasRef} style={{ display: "none" }} />

      <div className="mt-6 text-xs text-slate-500">
        Notes: audio samples are stored as 32-bit IEEE float PCM (interleaved). Video frames and images are stored as 8-bit RGBA frames produced by the browser. For exact original-file preservation, enable embedding of the original file.
      </div>
    </div>
  );
}
