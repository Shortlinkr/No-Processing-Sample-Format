import React, { useState, useRef, useCallback } from 'react';

// --- Utility Functions ---

const MAGIC = new Uint8Array([0x4E, 0x50, 0x53, 0x46, 0x01]); // 'NPSF\x01'

function u32BE(n) {
  const b = new Uint8Array(4);
  b[0] = (n >>> 24) & 0xFF;
  b[1] = (n >>> 16) & 0xFF;
  b[2] = (n >>> 8) & 0xFF;
  b[3] = (n >>> 0) & 0xFF;
  return b;
}

function readU32BE(buffer, offset) {
  const view = new DataView(buffer);
  return view.getUint32(offset, false);
}

// CRC32 table-based implementation
const crc32Table = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crc32Table[i] = c >>> 0;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crc32Table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (~c) >>> 0;
}

function typeToBytes(typeStr) {
  const t = (typeStr + '    ').slice(0, 4);
  return new TextEncoder().encode(t);
}

function makeChunk(typeStr, dataUint8) {
  const typeBytes = typeToBytes(typeStr);
  const lenBytes = u32BE(dataUint8.length);
  const chunk = new Uint8Array(4 + 4 + dataUint8.length + 4);
  
  chunk.set(typeBytes, 0);
  chunk.set(lenBytes, 4);
  chunk.set(dataUint8, 8);
  
  const crcInput = new Uint8Array(typeBytes.length + dataUint8.length);
  crcInput.set(typeBytes, 0);
  crcInput.set(dataUint8, typeBytes.length);
  
  chunk.set(u32BE(crc32(crcInput)), 8 + dataUint8.length);
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

// Format bytes for UI
function formatBytes(bytes, decimals = 2) {
  if (!+bytes) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export default function App() {
  const [activeTab, setActiveTab] = useState('pack');
  const [file, setFile] = useState(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('');
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef(null);

  // --- Handlers ---

  const handleDrag = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") setDragActive(true);
    else if (e.type === "dragleave") setDragActive(false);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
      setStatus('');
    }
  }, []);

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setStatus('');
    }
  };

  const triggerDownload = (buffer, filename, mimeType = 'application/octet-stream') => {
    const blob = new Blob([buffer], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // --- Core Processing Logic ---

  const packFile = async () => {
    if (!file) return;
    setIsProcessing(true);
    setStatus('Reading file...');

    try {
      const buffer = await file.arrayBuffer();
      const rawBytes = new Uint8Array(buffer);

      setStatus('Building NPSF container...');
      const headerObj = {
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        size: file.size,
        timestamp: Date.now()
      };
      
      const headerUtf8 = new TextEncoder().encode(JSON.stringify(headerObj));
      const parts = [
        MAGIC,
        u32BE(headerUtf8.length),
        headerUtf8,
        makeChunk('ORIG', rawBytes),
        makeChunk('END!', new Uint8Array(0))
      ];

      const npsfData = concatParts(parts);
      
      setStatus('Downloading...');
      triggerDownload(npsfData, `${file.name}.npsf`, 'application/x-npsf');
      setStatus('Success! File wrapped as .npsf');
    } catch (err) {
      console.error(err);
      setStatus(`Error packing: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  const unpackFile = async () => {
    if (!file) return;
    setIsProcessing(true);
    setStatus('Reading NPSF file...');

    try {
      const buffer = await file.arrayBuffer();
      const view = new Uint8Array(buffer);

      // 1. Check Magic bytes
      if (view.length < MAGIC.length) throw new Error("File too small");
      for (let i = 0; i < MAGIC.length; i++) {
        if (view[i] !== MAGIC[i]) throw new Error("Invalid NPSF magic header. Not a valid NPSF file.");
      }

      let offset = MAGIC.length;

      // 2. Read Header
      const headerLen = readU32BE(buffer, offset);
      offset += 4;
      
      const headerBytes = view.slice(offset, offset + headerLen);
      const headerJson = new TextDecoder().decode(headerBytes);
      const header = JSON.parse(headerJson);
      offset += headerLen;

      setStatus(`Found wrapped file: ${header.filename}`);

      // 3. Iterate Chunks
      let origBytes = null;
      
      while (offset < view.length) {
        if (offset + 8 > view.length) throw new Error("Unexpected end of file while reading chunks");
        
        const typeStr = new TextDecoder().decode(view.slice(offset, offset + 4));
        offset += 4;
        
        const chunkLen = readU32BE(buffer, offset);
        offset += 4;

        if (typeStr === 'END!') {
          break; // EOF marker
        }

        if (typeStr === 'ORIG') {
          origBytes = view.slice(offset, offset + chunkLen);
          // Optional: Verify CRC32 here
        }

        offset += chunkLen; // skip data
        offset += 4; // skip CRC32
      }

      if (!origBytes) throw new Error("No ORIG chunk found in the file. Corrupt or empty container.");

      setStatus('Extracting and downloading...');
      triggerDownload(origBytes, header.filename, header.mime_type);
      setStatus('Success! File unwrapped.');
      
    } catch (err) {
      console.error(err);
      setStatus(`Error unpacking: ${err.message}`);
    } finally {
      setIsProcessing(false);
    }
  };

  // --- UI Components ---

  const Icons = {
    Upload: () => (
      <svg className="w-12 h-12 text-indigo-400 mb-4 mx-auto" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
      </svg>
    ),
    Package: () => (
      <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
      </svg>
    ),
    Unpackage: () => (
      <svg className="w-5 h-5 mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
      </svg>
    ),
    FileIcon: () => (
      <svg className="w-8 h-8 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
      </svg>
    ),
    Close: () => (
      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
      </svg>
    )
  };

  return (
    <div className="min-h-screen bg-[#0B0F19] text-slate-200 flex items-center justify-center p-4 font-sans selection:bg-indigo-500/30">
      
      {/* Main Card */}
      <div className="w-full max-w-xl bg-[#131A2B] border border-slate-800/60 rounded-3xl shadow-2xl overflow-hidden relative">
        
        {/* Glow effect */}
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-indigo-600/20 rounded-full blur-[100px] pointer-events-none"></div>
        <div className="absolute -bottom-40 -left-40 w-96 h-96 bg-blue-600/10 rounded-full blur-[100px] pointer-events-none"></div>

        <div className="p-8 relative z-10">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 to-cyan-400 tracking-tight">
              NPSF Vault
            </h1>
            <p className="text-slate-400 mt-2 text-sm">
              Lossless file preservation container for social media.
            </p>
          </div>

          {/* Tabs */}
          <div className="flex bg-[#0B0F19] p-1 rounded-xl mb-8 border border-slate-800/50">
            <button
              onClick={() => { setActiveTab('pack'); setFile(null); setStatus(''); }}
              className={`flex-1 flex items-center justify-center py-3 text-sm font-semibold rounded-lg transition-all duration-300 ${
                activeTab === 'pack' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Icons.Package /> Pack (Encode)
            </button>
            <button
              onClick={() => { setActiveTab('unpack'); setFile(null); setStatus(''); }}
              className={`flex-1 flex items-center justify-center py-3 text-sm font-semibold rounded-lg transition-all duration-300 ${
                activeTab === 'unpack' ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
              }`}
            >
              <Icons.Unpackage /> Unpack (Decode)
            </button>
          </div>

          {/* Dropzone / File Selection */}
          {!file ? (
            <div
              className={`relative border-2 border-dashed rounded-2xl p-10 text-center transition-all duration-300 ease-out cursor-pointer ${
                dragActive ? 'border-indigo-500 bg-indigo-500/10 scale-[1.02]' : 'border-slate-700 hover:border-slate-500 hover:bg-slate-800/30'
              }`}
              onDragEnter={handleDrag}
              onDragLeave={handleDrag}
              onDragOver={handleDrag}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileChange}
                accept={activeTab === 'unpack' ? '.npsf' : '*/*'}
              />
              <Icons.Upload />
              <p className="text-base font-medium text-slate-200 mb-1">
                Drag & Drop your file here
              </p>
              <p className="text-sm text-slate-500">
                or click to browse from your device
              </p>
              {activeTab === 'unpack' && (
                <div className="mt-4 inline-block px-3 py-1 rounded-full bg-indigo-500/10 text-indigo-400 text-xs font-medium border border-indigo-500/20">
                  Requires .npsf file
                </div>
              )}
            </div>
          ) : (
            <div className="bg-[#0B0F19] border border-slate-700/50 rounded-2xl p-6 relative group transition-all">
              <button 
                onClick={() => { setFile(null); setStatus(''); }}
                className="absolute top-4 right-4 text-slate-500 hover:text-red-400 transition-colors bg-slate-800/50 rounded-full p-1"
                title="Remove file"
              >
                <Icons.Close />
              </button>
              
              <div className="flex items-center gap-4">
                <div className="p-3 bg-indigo-500/10 rounded-xl">
                  <Icons.FileIcon />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-slate-200 font-medium truncate text-sm">
                    {file.name}
                  </p>
                  <p className="text-slate-500 text-xs mt-0.5">
                    {formatBytes(file.size)}
                  </p>
                </div>
              </div>

              {/* Action Button */}
              <button
                onClick={activeTab === 'pack' ? packFile : unpackFile}
                disabled={isProcessing}
                className="w-full mt-6 bg-gradient-to-r from-indigo-600 to-blue-600 hover:from-indigo-500 hover:to-blue-500 text-white font-semibold py-3.5 px-4 rounded-xl shadow-[0_0_20px_rgba(79,70,229,0.3)] transition-all transform active:scale-[0.98] disabled:opacity-70 disabled:cursor-not-allowed flex justify-center items-center gap-2"
              >
                {isProcessing ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Processing...
                  </>
                ) : (
                  activeTab === 'pack' ? 'Secure & Pack to .npsf' : 'Extract & Download'
                )}
              </button>
            </div>
          )}

          {/* Status Message */}
          {status && (
            <div className={`mt-6 text-center text-sm font-medium ${
              status.includes('Error') ? 'text-red-400' : 
              status.includes('Success') ? 'text-green-400' : 
              'text-indigo-400 animate-pulse'
            }`}>
              {status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
