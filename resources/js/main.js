let filesList = [];
let currentFileType = null; // 'video', 'image', 'audio', 'pdf'
let outputPath = '';

// File Type detection
function getFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    const videoExts = ['mp4', 'mkv', 'avi', 'mov', 'webm'];
    const imageExts = ['jpg', 'jpeg', 'png', 'webp', 'avif', 'gif'];
    const audioExts = ['mp3', 'wav', 'aac', 'flac', 'ogg'];
    const pdfExts = ['pdf'];

    if (videoExts.includes(ext)) return 'video';
    if (imageExts.includes(ext)) return 'image';
    if (audioExts.includes(ext)) return 'audio';
    if (pdfExts.includes(ext)) return 'pdf';
    return null;
}

async function getMediaInfo(path, type) {
    try {
        const binPath = NL_PATH.replace(/\//g, '\\');
        let command = `"${binPath}\\binaries\\ffmpeg.exe" -i "${path}"`;
        let res = await Neutralino.os.execCommand(command);
        let output = res.stdErr;
        let match = output.match(/Duration:\s+(\d+):(\d+):(\d+\.\d+)/);
        let fpsMatch = output.match(/(\d+(?:\.\d+)?)\s+fps/);
        let dimMatch = output.match(/(?:,\s+)(\d+)x(\d+)(?:[,\s]|$)/);
        
        let duration = 0;
        let fps = fpsMatch ? parseFloat(fpsMatch[1]) : 0;
        let width = 0;
        let height = 0;
        
        if (match) {
            let hours = parseInt(match[1]);
            let mins = parseInt(match[2]);
            let secs = parseFloat(match[3]);
            duration = (hours * 3600) + (mins * 60) + secs;
        }
        if (dimMatch) {
            width = parseInt(dimMatch[1]);
            height = parseInt(dimMatch[2]);
        }
        return { duration, fps, width, height };
    } catch(e) {
        console.error("Failed to parse info from ffmpeg", e);
    }
    return null;
}

function updateEstimations() {
    if (filesList.length === 0) return;

    filesList.forEach((fileObj, index) => {
        let estSpan = document.getElementById(`file-est-${index}`);
        if (!estSpan) return;

        // Already converted: show the real result only, never a stale/hypothetical estimate
        if (fileObj.converted) {
            estSpan.innerHTML = '';
            return;
        }

        let currentSizeMB = fileObj.size / (1024 * 1024);
        
        let durationRatio = 1.0;
        if (fileObj.duration > 0 && fileObj.trimStart !== undefined && fileObj.trimEnd !== undefined) {
            durationRatio = (fileObj.trimEnd - fileObj.trimStart) / fileObj.duration;
        }
        
        let estMB = currentSizeMB * durationRatio;
        let targetFpsDisplay = '';

        if (currentFileType === 'video') {
            let qualityPercent = parseFloat(document.getElementById('video-quality').value) || 100;
            let speed = parseFloat(document.getElementById('video-speed').value) || 1.0;
            let customFps = document.getElementById('video-fps-custom').checked;
            let targetFpsStr = customFps ? document.getElementById('video-fps').value : 'original';
            let targetFps = targetFpsStr === 'original' ? fileObj.fps : parseFloat(targetFpsStr);
            
            if (targetFpsStr !== 'original') {
                targetFpsDisplay = `<span style="color: var(--muted); margin-left: 5px; font-size: 0.8em;">[${targetFpsStr} fps]</span>`;
            }

            let fpsFactor = 1.0;
            if (targetFps && fileObj.fps) {
                fpsFactor = targetFps / fileObj.fps;
            }
            
            let format = document.getElementById('video-format').value;
            if (format === '.gif') {
                let scaleFactor = qualityPercent / 100;
                estMB = currentSizeMB * durationRatio * (scaleFactor * scaleFactor) * fpsFactor * 2.5 / speed;
            } else {
                estMB = (currentSizeMB * durationRatio * (qualityPercent / 100) * fpsFactor) / speed;

                // Apply a codec compression-efficiency factor so switching codecs moves
                // the estimate, even though in the bitrate-targeted path (duration known)
                // the real output size is mostly set by the bitrate target itself.
                const codec = document.getElementById('video-codec').value;
                const codecFactor = { 'libx264': 1.0, 'libx265': 0.6, 'libvpx-vp9': 0.65, 'libsvtav1': 0.5 }[codec] || 1.0;
                estMB *= codecFactor;
            }
            if (estMB < 0.1) estMB = 0.1;
        }
        else if (currentFileType === 'audio') {
            let format = document.getElementById('audio-format').value;
            let bitrateStr = document.getElementById('audio-bitrate').value;
            let speed = parseFloat(document.getElementById('audio-speed').value) || 1.0;
            let kbps = parseInt(bitrateStr.replace('k', ''));
            
            if (format === '.flac') {
                kbps = 900; // FLAC average bitrate
            } else if (format === '.wav') {
                kbps = 1411; // WAV uncompressed CD quality
            }

            if (fileObj.duration) {
                let trimmedDuration = fileObj.duration * durationRatio;
                let calculatedEst = (kbps * 1000 * trimmedDuration) / 8 / (1024 * 1024) / speed;
                
                if ((format === '.flac' && fileObj.path.toLowerCase().endsWith('.flac')) || 
                    (format === '.wav' && fileObj.path.toLowerCase().endsWith('.wav'))) {
                    // For lossless -> lossless of same type, use original size as better baseline
                    estMB = currentSizeMB * durationRatio / speed;
                } else {
                    estMB = calculatedEst;
                }
            } else {
                estMB = estMB / speed;
            }
        }
        else if (currentFileType === 'image') {
            let format = document.getElementById('image-format').value;
            let quality = parseFloat(document.getElementById('image-quality').value) || 85;
            let scale = parseFloat(document.getElementById('image-scale').value) || 100;
            
            let baseSize = currentSizeMB;
            if (format === '.png') {
                if (!fileObj.path.toLowerCase().endsWith('.png')) {
                    baseSize = currentSizeMB * 2.5; // Inflate estimation if converting from lossy to PNG
                }
            } else if (fileObj.path.toLowerCase().endsWith('.png')) {
                baseSize = currentSizeMB * 0.4; // Deflate estimation if converting from PNG to lossy
            }

            estMB = baseSize * (quality / 100) * (scale / 100) * (scale / 100);
            
            let resPreview = document.getElementById('image-resolution-preview');
            if (fileObj.width && fileObj.height) {
                let w = Math.round(fileObj.width * (scale / 100));
                let h = Math.round(fileObj.height * (scale / 100));
                resPreview.innerText = `${w} x ${h}`;
            } else {
                if(resPreview) resPreview.innerText = '';
            }
        }
        else if (currentFileType === 'pdf') {
            let opt = document.getElementById('pdf-optimize').value;
            estMB = opt === 'compress' ? currentSizeMB * 0.7 : currentSizeMB * 1.02;
        }

        let color = estMB > currentSizeMB ? 'var(--danger)' : 'var(--accent)';
        let warning = estMB > currentSizeMB ? ' ⚠ inflates' : '';

        estSpan.innerHTML = ` <span style="color: ${color};">→ ~${estMB.toFixed(1)} MB${warning}</span>${targetFpsDisplay}`;
    });
}

function updateSettingsUI() {
    const settingsSection = document.getElementById('settings-section');
    const videoSettings = document.getElementById('video-settings');
    const imageSettings = document.getElementById('image-settings');
    const audioSettings = document.getElementById('audio-settings');
    const pdfSettings = document.getElementById('pdf-settings');
    // Update header type badge
    const typeBadge = document.getElementById('type-badge');
    const logoSep   = document.getElementById('logo-sep');

    if (filesList.length === 0) {
        settingsSection.classList.add('hidden');
        if (typeBadge) typeBadge.textContent = '';
        if (logoSep)   logoSep.classList.add('hidden');
        return;
    }

    settingsSection.classList.remove('hidden');
    // Wrap any newly-visible selects in liquid glass
    if (typeof initLiquidGlass === 'function') initLiquidGlass();
    videoSettings.classList.add('hidden');
    imageSettings.classList.add('hidden');
    audioSettings.classList.add('hidden');
    pdfSettings.classList.add('hidden');

    if (currentFileType === 'video') { videoSettings.classList.remove('hidden'); }
    if (currentFileType === 'image') { imageSettings.classList.remove('hidden'); }
    if (currentFileType === 'audio') { audioSettings.classList.remove('hidden'); }
    if (currentFileType === 'pdf')   { pdfSettings.classList.remove('hidden'); }

    if (typeBadge && currentFileType) {
        typeBadge.textContent = currentFileType.charAt(0).toUpperCase() + currentFileType.slice(1);
        if (logoSep) logoSep.classList.remove('hidden');
    }
}

function setStatus(text, state) {
    const dot  = document.getElementById('statusbar-dot');
    const label = document.getElementById('status-text');
    if (label) label.textContent = text;
    if (dot) {
        dot.className = 'statusbar-indicator';
        if (state === 'busy')  dot.classList.add('busy');
        if (state === 'error') dot.classList.add('error');
    }
}

function renderFileList() {
    const listEl = document.getElementById('file-list');
    const container = document.getElementById('file-list-container');
    const dropZone = document.getElementById('drop-zone');
    const label = document.getElementById('file-count-label');

    listEl.innerHTML = '';
    
    if (filesList.length === 0) {
        container.classList.add('hidden');
        dropZone.classList.remove('hidden');
        currentFileType = null;
        setStatus('Ready', 'ready');
    } else {
        container.classList.remove('hidden');
        dropZone.classList.add('hidden');
        label.innerText = `${filesList.length} file${filesList.length !== 1 ? 's' : ''} · ${currentFileType.toUpperCase()}`;
        setStatus(`${filesList.length} file${filesList.length !== 1 ? 's' : ''} selected`, 'ready');
        
        filesList.forEach(async (fileObj, index) => {
            const item = document.createElement('div');
            item.className = 'file-item';
            item.id = `file-item-${index}`;
            
            // Extract just the filename from path
            let filename = fileObj.path.split(/[\\/]/).pop();
            const sizeMB = (fileObj.size / (1024 * 1024)).toFixed(1);
            
            let fpsText = '';
            let trimText = '';
            if (currentFileType === 'video' || currentFileType === 'audio') {
                if (fileObj.trimStart !== undefined && fileObj.trimEnd !== undefined) {
                    trimText = `<span style="color: var(--accent); margin-left: 5px; font-size: 0.8em;">[Trim: ${(fileObj.trimEnd - fileObj.trimStart).toFixed(2)}s]</span>`;
                }
                if (currentFileType === 'video' && fileObj.fps) {
                    fpsText = `<span style="color: var(--muted); margin-left: 5px; font-size: 0.8em;">[${Math.round(fileObj.fps)} fps]</span>`;
                }
            }
            
            let trimBtn = '';
            if (currentFileType === 'video' || currentFileType === 'audio') {
                trimBtn = `<button class="btn-trim" onclick="openTrimModal(${index})" title="Trim Media"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="3"></circle><circle cx="6" cy="18" r="3"></circle><line x1="20" y1="4" x2="8.12" y2="15.88"></line><line x1="14.47" y1="14.48" x2="20" y2="20"></line><line x1="8.12" y1="8.12" x2="12" y2="12"></line></svg></button>`;
            }
            
            item.innerHTML = `
                <div>
                    <span title="${fileObj.path}">${filename}</span>
                    <span id="file-size-${index}" style="color: var(--muted); margin-left: 10px; font-size: 0.8em;">${sizeMB} MB</span>
                    ${trimText}
                    ${fpsText}
                    <span id="file-est-${index}" style="font-size: 0.8em; margin-left: 5px;"></span>
                </div>
                <div style="display: flex; gap: 8px;">
                    ${trimBtn}
                    <span class="remove" onclick="removeFile(${index})">X</span>
                </div>
            `;
            listEl.appendChild(item);
        });
    }
    updateSettingsUI();
    updateEstimations();
}

window.removeFile = function(index) {
    filesList.splice(index, 1);
    renderFileList();
}

async function handleFiles(paths) {
    const loadingOverlay = document.getElementById('file-loading-overlay');
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');

    try {
        for (let path of paths) {
            try {
                const type = getFileType(path);
                if (!type) {
                    alert(`Unsupported file type: ${path}`);
                    continue;
                }

                let isFirstValidFile = false;
                if (currentFileType === null) {
                    currentFileType = type;
                    isFirstValidFile = true;
                } else if (currentFileType !== type) {
                    alert(`Please only add ${currentFileType} files in this batch. Found: ${path}`);
                    continue;
                }

                if (isFirstValidFile) {
                    let ext = '.' + path.split('.').pop().toLowerCase();
                    if (ext === '.jpeg') ext = '.jpg';
                    let selectId = '';
                    if (type === 'video') selectId = 'video-format';
                    else if (type === 'image') selectId = 'image-format';
                    else if (type === 'audio') selectId = 'audio-format';
                    
                    if (selectId) {
                        let sel = document.getElementById(selectId);
                        if (sel && Array.from(sel.options).some(o => o.value === ext)) {
                            sel.value = ext;
                            if (window.LiquidSelect && typeof window.LiquidSelect.sync === 'function') {
                                window.LiquidSelect.sync(sel);
                            }
                            sel.dispatchEvent(new Event('change'));
                        }
                    }
                }

                // Avoid duplicates
                if (!filesList.find(f => f.path === path)) {
                    let stats = await Neutralino.filesystem.getStats(path);
                    let duration = 0;
                    let fps = 0;
                    let width = 0;
                    let height = 0;
                    if (type === 'video' || type === 'audio' || type === 'image') {
                        let info = await getMediaInfo(path, type);
                        if (info) {
                            duration = info.duration || 0;
                            fps = info.fps || 0;
                            width = info.width || 0;
                            height = info.height || 0;
                        }
                    }
                    filesList.push({ path: path, size: stats.size, duration: duration, fps: fps, width: width, height: height });
                }
            } catch (err) {
                console.error("Error processing file path: " + path, err);
                alert("Error reading file info: " + path + "\n" + err);
            }
        }
        
        if (filesList.length > 0 && !outputPath) {
            // Set default output path to the directory of the first file
            // Handle both Windows and Unix style slashes
            let lastSlash = filesList[0].path.lastIndexOf('\\');
            if (lastSlash === -1) lastSlash = filesList[0].path.lastIndexOf('/');
            
            if (lastSlash !== -1) {
                outputPath = filesList[0].path.substring(0, lastSlash);
                document.getElementById('output-path').value = outputPath;
            }
        }
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }

    renderFileList();
}

// Browser-mode drop fallback: copy dropped File objects into a temp dir so we
// get real filesystem paths (browser File objects never expose one).
let dropSeq = 0;

async function importDroppedFiles(files) {
    const loadingOverlay = document.getElementById('file-loading-overlay');

    const accepted = [];
    for (const file of files) {
        if (!getFileType(file.name)) {
            console.warn('Skipping unsupported drop entry:', file.name);
            setStatus(`Skipped unsupported file: ${file.name}`, 'error');
            continue;
        }
        if (file.size === 0) {
            console.warn('Skipping empty/folder drop entry:', file.name);
            continue;
        }
        // Temp paths differ per drop, so handleFiles' path-based dedupe cannot
        // catch a re-drop of the same file — match by name + size instead.
        const dup = filesList.find(f => f.path.split(/[\\/]/).pop() === file.name && f.size === file.size);
        if (dup) {
            console.warn('Skipping already-added drop entry:', file.name);
            continue;
        }
        accepted.push(file);
    }
    if (accepted.length === 0) return;

    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
    try {
        const tempBase = await Neutralino.os.getPath('temp');
        const dropDir = `${tempBase}\\FileConverterApp\\dropped\\${Date.now()}_${dropSeq++}`;
        await Neutralino.filesystem.createDirectory(dropDir);

        const tempPaths = [];
        for (let i = 0; i < accepted.length; i++) {
            const file = accepted[i];
            try {
                tempPaths.push(await copyDroppedFileToTemp(file, dropDir, (pct) => {
                    setStatus(`Copying dropped file ${i + 1}/${accepted.length} — ${pct}%`, 'busy');
                }));
            } catch (err) {
                console.error('Failed to import dropped file: ' + file.name, err);
                setStatus(`Failed to import ${file.name}`, 'error');
                try { await Neutralino.filesystem.remove(`${dropDir}\\${file.name}`); } catch (e) { /* partial file may not exist */ }
            }
        }
        if (tempPaths.length === 0) return;

        // The originals' directory is unknowable in browser mode; default the
        // output dir to Downloads so handleFiles never picks the temp dir.
        if (!outputPath) {
            outputPath = await Neutralino.os.getPath('downloads');
            document.getElementById('output-path').value = outputPath;
        }

        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        await handleFiles(tempPaths);
    } finally {
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
    }
}

async function copyDroppedFileToTemp(file, dropDir, onProgress) {
    const CHUNK = window.__DROP_CHUNK_SIZE || 8 * 1024 * 1024;
    const destPath = `${dropDir}\\${file.name}`;
    let offset = 0;
    while (offset < file.size) {
        const buf = await file.slice(offset, offset + CHUNK).arrayBuffer();
        if (offset === 0) {
            await Neutralino.filesystem.writeBinaryFile(destPath, buf);
        } else {
            await Neutralino.filesystem.appendBinaryFile(destPath, buf);
        }
        offset += CHUNK;
        if (onProgress) onProgress(Math.min(100, Math.round(offset / file.size * 100)));
    }
    return destPath;
}

// Neutralino Events
Neutralino.init();

// Best-effort cleanup of temp copies from previous sessions
(async () => {
    try {
        const tempBase = await Neutralino.os.getPath('temp');
        await Neutralino.filesystem.remove(`${tempBase}\\FileConverterApp\\dropped`);
    } catch (e) { /* first run / dir absent — ignore */ }
})();

Neutralino.events.on('windowClose', () => {
    Neutralino.app.exit();
});

// Native drag and drop visual effects
let dragCounter = 0;

document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    document.body.classList.add('drag-active');
    const dropZone = document.getElementById('drop-zone');
    if (dropZone && !dropZone.classList.contains('hidden')) {
        dropZone.classList.add('dragover');
    }
});

document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter === 0) {
        document.body.classList.remove('drag-active');
        const dropZone = document.getElementById('drop-zone');
        if (dropZone) dropZone.classList.remove('dragover');
    }
});

document.addEventListener('dragover', (e) => {
    e.preventDefault();
});

document.addEventListener('drop', (e) => {
    e.preventDefault(); // prevent the browser from navigating to the dropped file

    dragCounter = 0;
    document.body.classList.remove('drag-active');
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) dropZone.classList.remove('dragover');

    // Window mode gets real paths via the native filesDropped event; reading
    // dataTransfer here as well would double-add the files.
    if (window.NL_MODE === 'window') return;
    const files = (e.dataTransfer && e.dataTransfer.files) ? Array.from(e.dataTransfer.files) : [];
    if (files.length > 0) importDroppedFiles(files);
});

// Setup drag and drop for Neutralino v6.8.0
Neutralino.events.on('filesDropped', (event) => {
    // Clear visual states
    dragCounter = 0;
    document.body.classList.remove('drag-active');
    const dropZone = document.getElementById('drop-zone');
    if (dropZone) dropZone.classList.remove('dragover');

    // Neutralino 6.8.0 sends an array of absolute path strings; keep a thin
    // defensive layer for string / {path} shapes.
    const detail = event.detail;
    let paths = [];
    if (Array.isArray(detail)) {
        paths = detail.map(f => typeof f === 'string' ? f : (f && f.path)).filter(Boolean);
    } else if (typeof detail === 'string') {
        paths = [detail];
    }

    if (paths.length > 0) {
        handleFiles(paths);
    } else if (detail != null && !Array.isArray(detail)) {
        console.error('Unrecognized filesDropped payload:', detail);
        setStatus('Drop failed — unrecognized payload', 'error');
    }
});

function runCommandWithLogs(command, onProgress) {
    return new Promise(async (resolve, reject) => {
        try {
            let processInfo = await Neutralino.os.spawnProcess(command);
            let pid = processInfo.id;
            let term = document.getElementById('terminal-log');
            
            let handler = (evt) => {
                if (evt.detail.id === pid) {
                    if (evt.detail.action === 'stdOut' || evt.detail.action === 'stdErr') {
                        term.innerText += evt.detail.data;
                        // Keep scrolled to bottom
                        term.scrollTop = term.scrollHeight;
                        if (onProgress) onProgress(evt.detail.data);
                    }
                    if (evt.detail.action === 'exit') {
                        Neutralino.events.off('spawnedProcess', handler);
                        if (Number(evt.detail.data) === 0) resolve();
                        else reject(new Error('Exit code ' + evt.detail.data));
                    }
                }
            };
            Neutralino.events.on('spawnedProcess', handler);
        } catch (e) {
            reject(e);
        }
    });
}

// ── Theme Toggle ────────────────────────────────────────────
(function() {
    var root = document.documentElement;
    var btn  = document.getElementById('theme-toggle');
    if (!btn) return;

    function applyTheme(theme) {
        root.setAttribute('data-theme', theme);
        localStorage.setItem('estella-theme', theme);
    }

    btn.addEventListener('click', function() {
        var current = root.getAttribute('data-theme') || 'dark';
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });
})();

// ── Trim Modal Logic ─────────────────────────────────────────
let currentTrimIndex = -1;

function formatTrimTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00:00.000";
    let h = Math.floor(seconds / 3600);
    let m = Math.floor((seconds % 3600) / 60);
    let s = Math.floor(seconds % 60);
    let ms = Math.floor((seconds % 1) * 1000);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
}

function parseTrimTime(timeStr) {
    let parts = timeStr.trim().split(':');
    if (parts.length === 3) {
        let h = parseInt(parts[0], 10);
        let m = parseInt(parts[1], 10);
        let s = parseFloat(parts[2]);
        return (h * 3600) + (m * 60) + s;
    }
    return parseFloat(timeStr) || 0;
}

// ── Custom Slider Logic ────────────────────────────────────
let currentTrimFileDuration = 0;
let currentTrimStart = 0;
let currentTrimEnd = 0;
let activeTrimPlayer = null;
let isDraggingThumb = null; // 'left' or 'right'

function formatTrimLabel(seconds) {
    if (isNaN(seconds) || seconds < 0) return "0.0s";
    return seconds.toFixed(1) + "s";
}

function updateSliderUI() {
    let pctStart = 0;
    let pctEnd = 100;
    if (currentTrimFileDuration > 0) {
        pctStart = (currentTrimStart / currentTrimFileDuration) * 100;
        pctEnd = (currentTrimEnd / currentTrimFileDuration) * 100;
    }
    document.getElementById('trim-thumb-left').style.left = pctStart + '%';
    document.getElementById('trim-thumb-right').style.left = pctEnd + '%';
    document.getElementById('trim-slider-range').style.left = pctStart + '%';
    document.getElementById('trim-slider-range').style.width = (pctEnd - pctStart) + '%';
    document.getElementById('trim-dim-left').style.width = pctStart + '%';
    document.getElementById('trim-dim-right').style.width = (100 - pctEnd) + '%';
    
    document.getElementById('trim-label-start').innerText = formatTrimLabel(currentTrimStart);
    document.getElementById('trim-label-end').innerText = formatTrimLabel(currentTrimEnd);

    let selDuration = currentTrimEnd - currentTrimStart;
    let selPct = currentTrimFileDuration > 0 ? (selDuration / currentTrimFileDuration) * 100 : 0;
    document.getElementById('trim-duration-info').innerText = `${selDuration.toFixed(2)}s selected (${selPct.toFixed(1)}%)`;
}

window.openTrimModal = async function(index) {
    currentTrimIndex = index;
    const fileObj = filesList[index];
    if (!fileObj) return;

    const modal = document.getElementById('trim-modal');
    const vidPlayer = document.getElementById('trim-video-player');
    const audPlayer = document.getElementById('trim-audio-player');
    
    // Reset players
    vidPlayer.classList.add('hidden');
    audPlayer.classList.add('hidden');
    vidPlayer.pause();
    audPlayer.pause();
    vidPlayer.removeAttribute('src');
    audPlayer.removeAttribute('src');

    currentTrimFileDuration = fileObj.duration || 0;
    currentTrimStart = fileObj.trimStart !== undefined ? fileObj.trimStart : 0;
    currentTrimEnd = fileObj.trimEnd !== undefined ? fileObj.trimEnd : currentTrimFileDuration;
    
    updateSliderUI();

    // Mount directory
    let filename = fileObj.path.split(/[\\/]/).pop();
    let lastSlash = fileObj.path.lastIndexOf('\\');
    if (lastSlash === -1) lastSlash = fileObj.path.lastIndexOf('/');
    let dirPath = fileObj.path.substring(0, lastSlash);
    
    try {
        await Neutralino.server.mount('/preview', dirPath);
        let fileUrl = `http://localhost:${NL_PORT}/preview/${encodeURIComponent(filename)}`;
        
        activeTrimPlayer = currentFileType === 'video' ? vidPlayer : audPlayer;
        activeTrimPlayer.classList.remove('hidden');
        activeTrimPlayer.src = fileUrl;
        activeTrimPlayer.load();
        
        let volSlider = document.getElementById('trim-volume-slider');
        activeTrimPlayer.volume = parseFloat(volSlider.value);

        modal.classList.remove('hidden');
    } catch (e) {
        console.error("Failed to mount for preview:", e);
        alert("Could not load preview. Is local server disabled?");
    }
};

window.closeTrimModal = function() {
    const modal = document.getElementById('trim-modal');
    modal.classList.add('hidden');
    
    if (activeTrimPlayer) {
        activeTrimPlayer.pause();
        activeTrimPlayer = null;
    }
    
    try {
        Neutralino.server.unmount('/preview');
    } catch (e) {}
};

document.addEventListener('DOMContentLoaded', () => {
    // Top Bar Actions
    document.getElementById('btn-cancel-trim').addEventListener('click', window.closeTrimModal);
    
    document.getElementById('btn-set-start').addEventListener('click', () => {
        if (!activeTrimPlayer) return;
        currentTrimStart = activeTrimPlayer.currentTime;
        if (currentTrimStart > currentTrimEnd) currentTrimStart = currentTrimEnd;
        updateSliderUI();
    });

    document.getElementById('btn-set-end').addEventListener('click', () => {
        if (!activeTrimPlayer) return;
        currentTrimEnd = activeTrimPlayer.currentTime;
        if (currentTrimEnd < currentTrimStart) currentTrimEnd = currentTrimStart;
        updateSliderUI();
    });

    // Volume Control Logic
    const volSlider = document.getElementById('trim-volume-slider');
    const btnMute = document.getElementById('btn-trim-mute');
    const iconVolOn = document.querySelector('.icon-vol-on');
    const iconVolOff = document.querySelector('.icon-vol-off');
    let previousVolume = 1.0;

    function updateMuteIcon(vol, muted) {
        if (vol === 0 || muted) {
            iconVolOn.classList.add('hidden');
            iconVolOff.classList.remove('hidden');
        } else {
            iconVolOn.classList.remove('hidden');
            iconVolOff.classList.add('hidden');
        }
    }

    volSlider.addEventListener('input', (e) => {
        let vol = parseFloat(e.target.value);
        if (activeTrimPlayer) {
            activeTrimPlayer.volume = vol;
            if (vol > 0) activeTrimPlayer.muted = false;
        }
        updateMuteIcon(vol, activeTrimPlayer ? activeTrimPlayer.muted : false);
    });

    btnMute.addEventListener('click', () => {
        if (!activeTrimPlayer) return;
        if (activeTrimPlayer.muted || activeTrimPlayer.volume === 0) {
            // Unmute
            activeTrimPlayer.muted = false;
            if (previousVolume === 0) previousVolume = 1.0;
            activeTrimPlayer.volume = previousVolume;
            volSlider.value = previousVolume;
        } else {
            // Mute
            previousVolume = activeTrimPlayer.volume;
            activeTrimPlayer.muted = true;
            activeTrimPlayer.volume = 0;
            volSlider.value = 0;
        }
        updateMuteIcon(activeTrimPlayer.volume, activeTrimPlayer.muted);
    });

    // Looping Logic
    const vidPlayer = document.getElementById('trim-video-player');
    const audPlayer = document.getElementById('trim-audio-player');
    let isLooping = true;
    
    const btnTrimLoop = document.getElementById('btn-trim-loop');
    if (btnTrimLoop) {
        btnTrimLoop.addEventListener('click', () => {
            isLooping = !isLooping;
            if (isLooping) {
                btnTrimLoop.classList.remove('btn-loop-off');
            } else {
                btnTrimLoop.classList.add('btn-loop-off');
            }
        });
    }
    
    const onTimeUpdate = (e) => {
        const p = e.target;
        if (isLooping) {
            if (p.currentTime >= currentTrimEnd) {
                p.currentTime = currentTrimStart;
                p.play().catch(()=>{});
            }
        }
        // Update playhead
        if (currentTrimFileDuration > 0) {
            let pct = (p.currentTime / currentTrimFileDuration) * 100;
            document.getElementById('trim-playhead').style.left = pct + '%';
        }
    };
    vidPlayer.addEventListener('timeupdate', onTimeUpdate);
    audPlayer.addEventListener('timeupdate', onTimeUpdate);

    const updatePlayIcon = () => {
        if (!activeTrimPlayer) return;
        if (activeTrimPlayer.paused) {
            document.querySelector('.icon-play').classList.remove('hidden');
            document.querySelector('.icon-pause').classList.add('hidden');
        } else {
            document.querySelector('.icon-play').classList.add('hidden');
            document.querySelector('.icon-pause').classList.remove('hidden');
        }
    };
    vidPlayer.addEventListener('play', updatePlayIcon);
    vidPlayer.addEventListener('pause', updatePlayIcon);
    audPlayer.addEventListener('play', updatePlayIcon);
    audPlayer.addEventListener('pause', updatePlayIcon);

    const togglePlayPause = () => {
        if (!activeTrimPlayer) return;
        if (activeTrimPlayer.paused) {
            activeTrimPlayer.play().catch(()=>{});
        } else {
            activeTrimPlayer.pause();
        }
    };

    document.getElementById('btn-trim-play-pause').addEventListener('click', togglePlayPause);
    vidPlayer.addEventListener('click', togglePlayPause);
    audPlayer.addEventListener('click', togglePlayPause);

    // Slider Drag Logic
    const sliderContainer = document.getElementById('trim-slider-container');
    const thumbLeft = document.getElementById('trim-thumb-left');
    const thumbRight = document.getElementById('trim-thumb-right');

    const getSecondsFromX = (clientX) => {
        if (currentTrimFileDuration <= 0) return 0;
        const rect = sliderContainer.getBoundingClientRect();
        let pct = (clientX - rect.left) / rect.width;
        pct = Math.max(0, Math.min(1, pct));
        return pct * currentTrimFileDuration;
    };

    sliderContainer.addEventListener('mousedown', (e) => {
        if (e.target === thumbLeft || e.target === thumbRight) return;
        isDraggingThumb = 'playhead';
        let sec = getSecondsFromX(e.clientX);
        if (activeTrimPlayer) {
            activeTrimPlayer.currentTime = sec;
        }
    });

    thumbLeft.addEventListener('mousedown', (e) => {
        isDraggingThumb = 'left';
        thumbLeft.classList.add('active');
        e.preventDefault();
    });

    thumbRight.addEventListener('mousedown', (e) => {
        isDraggingThumb = 'right';
        thumbRight.classList.add('active');
        e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDraggingThumb) return;
        
        let sec = getSecondsFromX(e.clientX);
        
        if (isDraggingThumb === 'playhead') {
            if (activeTrimPlayer) activeTrimPlayer.currentTime = sec;
            return;
        }

        if (isDraggingThumb === 'left') {
            if (sec > currentTrimEnd) sec = currentTrimEnd;
            currentTrimStart = sec;
        } else if (isDraggingThumb === 'right') {
            if (sec < currentTrimStart) sec = currentTrimStart;
            currentTrimEnd = sec;
        }
        updateSliderUI();
        
        if (activeTrimPlayer) {
            activeTrimPlayer.currentTime = sec;
        }
    });

    window.addEventListener('mouseup', () => {
        if (isDraggingThumb) {
            thumbLeft.classList.remove('active');
            thumbRight.classList.remove('active');
            isDraggingThumb = null;
        }
    });

    // Save & Clear
    document.getElementById('btn-clear-trim').addEventListener('click', () => {
        currentTrimStart = 0;
        currentTrimEnd = currentTrimFileDuration;
        updateSliderUI();
    });

    document.getElementById('btn-save-trim').addEventListener('click', () => {
        if (currentTrimIndex >= 0) {
            // If the whole video is selected, clear the trim data so we don't pass redundant flags to ffmpeg
            if (currentTrimStart === 0 && currentTrimEnd === currentTrimFileDuration) {
                filesList[currentTrimIndex].trimStart = undefined;
                filesList[currentTrimIndex].trimEnd = undefined;
            } else {
                filesList[currentTrimIndex].trimStart = currentTrimStart;
                filesList[currentTrimIndex].trimEnd = currentTrimEnd;
            }
        }
        window.closeTrimModal();
        renderFileList();
    });

    // Initialise liquid glass dropdowns
    if (typeof initLiquidGlass === 'function') initLiquidGlass();

    // Click to browse
    document.getElementById('drop-zone').addEventListener('click', async () => {
        let entries = await Neutralino.os.showOpenDialog('Select files', {
            multiSelections: true
        });
        if (entries && entries.length > 0) {
            handleFiles(entries);
        }
    });

    document.getElementById('btn-add-files').addEventListener('click', async () => {
        let entries = await Neutralino.os.showOpenDialog('Select files', {
            multiSelections: true
        });
        if (entries && entries.length > 0) {
            handleFiles(entries);
        }
    });

    document.getElementById('btn-clear-files').addEventListener('click', () => {
        filesList = [];
        renderFileList();
    });

    // Estimation listeners
    const inputs = ['video-quality', 'audio-bitrate', 'image-quality', 'pdf-optimize'];
    inputs.forEach(id => {
        let el = document.getElementById(id);
        if(el) {
            el.addEventListener('input', updateEstimations);
            el.addEventListener('change', updateEstimations);
        }
    });
    
    document.getElementById('video-format').addEventListener('change', (e) => {
        const codecGroup = document.getElementById('video-codec-group');
        if (codecGroup) codecGroup.style.display = e.target.value === '.gif' ? 'none' : 'block';
        updateEstimations();
    });
    document.getElementById('video-codec').addEventListener('change', updateEstimations);
    document.getElementById('audio-format').addEventListener('change', (e) => {
        let bitrateEl = document.getElementById('audio-bitrate');
        if (e.target.value === '.flac' || e.target.value === '.wav') {
            bitrateEl.disabled = true;
        } else {
            bitrateEl.disabled = false;
        }
        updateEstimations();
    });
    document.getElementById('audio-bitrate').addEventListener('change', updateEstimations);
    document.getElementById('audio-speed').addEventListener('input', updateEstimations);
    document.getElementById('video-fps').addEventListener('input', updateEstimations);
    document.getElementById('video-fps-custom').addEventListener('change', updateEstimations);
    document.getElementById('video-speed').addEventListener('input', updateEstimations);

    // Sync span on load and add event listeners for sliders
    const vidQ = document.getElementById('video-quality');
    const upscaleCb = document.getElementById('video-upscale');
    
    if (vidQ) {
        const vidQVal = document.getElementById('video-quality-val');
        vidQVal.innerText = vidQ.value;
        vidQ.addEventListener('input', (e) => {
            vidQVal.innerText = e.target.value;
        });
    }

    const vidFps = document.getElementById('video-fps');
    const vidFpsCb = document.getElementById('video-fps-custom');
    const vidFpsVal = document.getElementById('video-fps-val');
    
    if (vidFpsCb && vidFps) {
        vidFpsCb.addEventListener('change', (e) => {
            vidFps.disabled = !e.target.checked;
            vidFpsVal.innerText = e.target.checked ? vidFps.value : 'Original';
        });
        vidFps.addEventListener('input', (e) => {
            vidFpsVal.innerText = e.target.value;
        });
    }

    const vidSpeed = document.getElementById('video-speed');
    const vidSpeedVal = document.getElementById('video-speed-val');
    if (vidSpeed) {
        vidSpeedVal.innerText = parseFloat(vidSpeed.value).toFixed(2);
        vidSpeed.addEventListener('input', (e) => {
            vidSpeedVal.innerText = parseFloat(e.target.value).toFixed(2);
        });
    }
    
    const audSpeed = document.getElementById('audio-speed');
    const audSpeedVal = document.getElementById('audio-speed-val');
    if (audSpeed) {
        audSpeedVal.innerText = parseFloat(audSpeed.value).toFixed(2);
        audSpeed.addEventListener('input', (e) => {
            audSpeedVal.innerText = parseFloat(e.target.value).toFixed(2);
        });
    }

    const imgQuality = document.getElementById('image-quality');
    const imgQualityVal = document.getElementById('image-quality-val');
    if (imgQuality) {
        imgQualityVal.innerText = imgQuality.value;
        imgQuality.addEventListener('input', (e) => {
            imgQualityVal.innerText = e.target.value;
            updateEstimations();
        });
    }

    const imgFormat = document.getElementById('image-format');
    if (imgFormat && imgQuality) {
        imgFormat.addEventListener('change', (e) => {
            updateEstimations();
        });
    }

    const imgScale = document.getElementById('image-scale');
    const imgScaleVal = document.getElementById('image-scale-val');
    if (imgScale) {
        imgScaleVal.innerText = imgScale.value;
        imgScale.addEventListener('input', (e) => {
            imgScaleVal.innerText = e.target.value;
            updateEstimations();
        });
    }

    if (upscaleCb && vidQ) {
        upscaleCb.addEventListener('change', (e) => {
            if (e.target.checked) {
                vidQ.max = 200;
            } else {
                vidQ.max = 100;
                if (parseInt(vidQ.value) > 100) {
                    vidQ.value = 100;
                    document.getElementById('video-quality-val').innerText = 100;
                }
            }
            updateEstimations();
        });
    }

    document.getElementById('btn-select-output').addEventListener('click', async () => {
        let entry = await Neutralino.os.showFolderDialog('Select Output Folder');
        if (entry) {
            outputPath = entry;
            document.getElementById('output-path').value = outputPath;
        }
    });

async function getUniqueOutPath(outputPath, nameWithoutExt, format) {
    const slash = outputPath.includes('/') && !outputPath.includes('\\') ? '/' : '\\';
    let baseName = `${nameWithoutExt}_converted`;
    let outPath = `${outputPath}${slash}${baseName}${format}`;
    
    while (true) {
        try {
            await Neutralino.filesystem.getStats(outPath);
            baseName += '_converted';
            outPath = `${outputPath}${slash}${baseName}${format}`;
        } catch (e) {
            return outPath;
        }
    }
}

    document.getElementById('btn-execute').addEventListener('click', async () => {
        if (filesList.length === 0) return;
        
        const btn = document.getElementById('btn-execute');
        const progressWrapper = document.getElementById('progress-wrapper');
        const progressBar = document.getElementById('progress-bar');
        const progressText = document.getElementById('progress-text');
        
        // Ensure outputPath is set
        if (!outputPath && filesList.length > 0) {
            let lastSlash = filesList[0].path.lastIndexOf('\\');
            if (lastSlash === -1) lastSlash = filesList[0].path.lastIndexOf('/');
            if (lastSlash !== -1) {
                outputPath = filesList[0].path.substring(0, lastSlash);
                document.getElementById('output-path').value = outputPath;
            }
        }
        
        btn.disabled = true;
        progressWrapper.classList.remove('hidden');
        setStatus('Processing…', 'busy');
        
        let completed = 0;

        try {
            for (let i = 0; i < filesList.length; i++) {
                const fileObj = filesList[i];
                const file = fileObj.path;
                const filename = file.split(/[\\/]/).pop();
                const nameWithoutExt = filename.substring(0, filename.lastIndexOf('.'));
                const binPath = NL_PATH.replace(/\//g, '\\');
                
                // Update UI
                progressText.innerText = `Processing: ${filename} (${i + 1}/${filesList.length})`;
                progressBar.style.width = `${((i) / filesList.length) * 100}%`;
                
                let command = '';
                let outPath = '';
                
                // Build command based on type
                if (currentFileType === 'video') {
                    const format = document.getElementById('video-format').value;
                    const codec = document.getElementById('video-codec').value;
                    const qualityPercent = document.getElementById('video-quality').value;
                    const speed = document.getElementById('video-speed').value;
                    let customFps = document.getElementById('video-fps-custom').checked;
                    let targetFpsStr = customFps ? document.getElementById('video-fps').value : 'original';
                    let fps = targetFpsStr;
                    let targetFps = targetFpsStr === 'original' ? fileObj.fps : parseFloat(targetFpsStr);
                    
                    outPath = await getUniqueOutPath(outputPath, nameWithoutExt, format);
                    
                    let trimCmd = '';
                    if (fileObj.trimStart !== undefined) trimCmd += `-ss ${fileObj.trimStart} `;
                    if (fileObj.trimEnd !== undefined) trimCmd += `-to ${fileObj.trimEnd} `;
                    
                    if (format === '.gif') {
                        let filterGraph = [];
                        if (targetFps) filterGraph.push(`fps=${targetFps}`);
                        
                        const speedFloat = parseFloat(speed);
                        if (speedFloat !== 1.0) filterGraph.push(`setpts=${1/speedFloat}*PTS`);
                        
                        let scaleFactor = qualityPercent / 100;
                        if (scaleFactor < 1.0) {
                            filterGraph.push(`scale=trunc(iw*${scaleFactor}/2)*2:-2:flags=lanczos`);
                        }
                        
                        let preFilters = filterGraph.length > 0 ? filterGraph.join(',') + ',' : '';
                        let fullFilter = `${preFilters}split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`;
                        
                        command = `"${binPath}\\binaries\\ffmpeg.exe" -y ${trimCmd}-i "${file}" -filter_complex "${fullFilter}" "${outPath}"`;
                    } else {
                        let fpsFactor = 1.0;
                        if (targetFps && fileObj.fps) {
                            fpsFactor = targetFps / fileObj.fps;
                        }
                        
                        let targetBitrateCmd = '';
                        if (fileObj.duration > 0) {
                            const originalBitrateKbps = (fileObj.size * 8) / (fileObj.duration * 1024);
                            const targetBitrateKbps = Math.max(10, Math.floor(originalBitrateKbps * (qualityPercent / 100) * fpsFactor));
                            targetBitrateCmd = `-b:v ${targetBitrateKbps}k -bufsize ${targetBitrateKbps * 2}k`;
                        } else {
                            const crf = 51 - Math.round((qualityPercent / 100) * 51);
                            targetBitrateCmd = `-crf ${crf}`;
                        }
                        
                        let extraFilters = [];
                        let audioFilters = [];
                        
                        if (fps !== 'original') {
                            extraFilters.push(`fps=${fps}`);
                        }
                        
                        if (speed !== "1.0" && speed !== "1") {
                            const speedFloat = parseFloat(speed);
                            const ptsRatio = 1 / speedFloat;
                            extraFilters.push(`setpts=${ptsRatio}*PTS`);
                            audioFilters.push(`atempo=${speedFloat}`);
                        }
                        
                        let filterCmd = '';
                        if (extraFilters.length > 0) {
                            filterCmd += `-vf "${extraFilters.join(',')}" `;
                        }
                        if (audioFilters.length > 0) {
                            filterCmd += `-af "${audioFilters.join(',')}" `;
                        }
                        
                        command = `"${binPath}\\binaries\\ffmpeg.exe" -y ${trimCmd}-i "${file}" -c:v ${codec} ${filterCmd}${targetBitrateCmd} "${outPath}"`;
                    }
                } 
                else if (currentFileType === 'image') {
                    const format = document.getElementById('image-format').value;
                    const quality = document.getElementById('image-quality').value;
                    const scale = document.getElementById('image-scale').value;
                    
                    outPath = await getUniqueOutPath(outputPath, nameWithoutExt, format);
                    let qCmd = '';
                    let filterCmd = '';
                    let filters = [];
                    
                    if (format === '.jpg' || format === '.jpeg') {
                        let qv = Math.max(2, Math.min(31, 31 - Math.round((quality / 100) * 29)));
                        qCmd = `-q:v ${qv}`;
                    } else if (format === '.webp') {
                        qCmd = `-q:v ${quality}`;
                    } 
                    
                    let scaleFilter = '';
                    if (scale < 100) {
                        let scaleFactor = scale / 100;
                        scaleFilter = `scale=trunc(iw*${scaleFactor}/2)*2:-2:flags=lanczos`;
                    }

                    if (format === '.png' && quality < 100) {
                        let colors = Math.max(2, Math.floor(256 * (quality / 100)));
                        if (scaleFilter) {
                            filterCmd = `-filter_complex "[0:v]${scaleFilter}[s];[s]split[a][b];[a]palettegen=max_colors=${colors}[p];[b][p]paletteuse"`;
                        } else {
                            filterCmd = `-filter_complex "[0:v]split[a][b];[a]palettegen=max_colors=${colors}[p];[b][p]paletteuse"`;
                        }
                    } else if (scaleFilter) {
                        filterCmd = `-vf "${scaleFilter}"`;
                    }
                    
                    command = `"${binPath}\\binaries\\ffmpeg.exe" -y -i "${file}" ${filterCmd} ${qCmd} "${outPath}"`;
                }
                else if (currentFileType === 'audio') {
                    const format = document.getElementById('audio-format').value;
                    const bitrate = document.getElementById('audio-bitrate').value;
                    const speed = document.getElementById('audio-speed').value;
                    
                    let filterCmd = '';
                    const speedFloat = parseFloat(speed);
                    if (speedFloat !== 1.0) {
                        filterCmd = `-af "atempo=${speedFloat}" `;
                    }
                    
                    outPath = await getUniqueOutPath(outputPath, nameWithoutExt, format);
                    
                    let trimCmd = '';
                    if (fileObj.trimStart !== undefined) trimCmd += `-ss ${fileObj.trimStart} `;
                    if (fileObj.trimEnd !== undefined) trimCmd += `-to ${fileObj.trimEnd} `;
                    
                    command = `"${binPath}\\binaries\\ffmpeg.exe" -y ${trimCmd}-i "${file}" ${filterCmd}-b:a ${bitrate} "${outPath}"`;
                }
                else if (currentFileType === 'pdf') {
                    const optimize = document.getElementById('pdf-optimize').value;
                    
                    outPath = await getUniqueOutPath(outputPath, nameWithoutExt, '.pdf');
                    
                    const optFlag = optimize === 'linearize' ? '--linearize' : '--stream-data=compress';
                    command = `"${binPath}\\binaries\\qpdf.exe" ${optFlag} "${file}" "${outPath}"`;
                }

                if (command) {
                    try {
                        let term = document.getElementById('terminal-log');
                        term.innerText += `\n> Executing: ${command}\n`;
                        term.scrollTop = term.scrollHeight;

                        await runCommandWithLogs(command, (data) => {
                            if (fileObj.duration) {
                                let timeMatch = data.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
                                if (timeMatch) {
                                    let h = parseInt(timeMatch[1], 10);
                                    let m = parseInt(timeMatch[2], 10);
                                    let s = parseFloat(timeMatch[3]);
                                    let currentSec = h * 3600 + m * 60 + s;
                                    
                                    let speed = 1.0;
                                    if (currentFileType === 'video') {
                                        speed = parseFloat(document.getElementById('video-speed').value) || 1.0;
                                    } else if (currentFileType === 'audio') {
                                        speed = parseFloat(document.getElementById('audio-speed').value) || 1.0;
                                    }
                                    
                                    let totalOutputDuration = fileObj.duration / speed;
                                    let percent = (currentSec / totalOutputDuration) * 100;
                                    if (percent > 100) percent = 100;
                                    
                                    document.getElementById('progress-bar').style.width = `${percent}%`;
                                    document.getElementById('progress-text').innerText = `Processing: ${filename} (${i + 1}/${filesList.length}) - ${Math.round(percent)}%`;
                                }
                            }
                        });

                        // Set to 100% when finished
                        document.getElementById('progress-bar').style.width = '100%';
                        document.getElementById('progress-text').innerText = `Processing: ${filename} (${i + 1}/${filesList.length}) - 100%`;
                        
                        completed++;
                        
                        // Fetch new file size
                        try {
                            let newStats = await Neutralino.filesystem.getStats(outPath);
                            let newSizeMB = (newStats.size / (1024 * 1024)).toFixed(2);
                            let sizeSpan = document.getElementById(`file-size-${i}`);
                            if (sizeSpan) {
                                let originalSizeMB = (fileObj.size / (1024 * 1024)).toFixed(2);
                                sizeSpan.innerHTML = `(${originalSizeMB} MB) <span style="color: var(--accent);">→ ${newSizeMB} MB</span>`;
                            }
                            // Real size is now known — stop showing a pre-conversion estimate for this file
                            fileObj.converted = true;
                            let estSpan = document.getElementById(`file-est-${i}`);
                            if (estSpan) estSpan.innerHTML = '';
                        } catch (e) { console.error("Could not read new file size", e); }
                        
                    } catch(err) {
                        alert(`Failed to process ${filename}:\n${err.message || err}`);
                        setStatus(`Error: ${filename}`, 'error');
                    }
                }
            }
        } catch(fatalErr) {
            alert("FATAL ERROR inside loop:\n" + (fatalErr.message || fatalErr) + "\n" + fatalErr.stack);
            setStatus('Fatal error', 'error');
        }
        
        progressBar.style.width = `100%`;
        progressText.innerText = `Completed ${completed} of ${filesList.length}!`;
        setStatus(`Done — ${completed} of ${filesList.length} converted`, 'ready');
        btn.disabled = false;
        setTimeout(() => {
            progressWrapper.classList.add('hidden');
            progressText.innerText = 'Processing...';
            progressBar.style.width = '0%';
        }, 5000);
    });
});
