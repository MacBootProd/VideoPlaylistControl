const { invoke, convertFileSrc } = window.__TAURI__.core;

// --- I18N ENGINE ---
let currentLang = 'en';

// Translation for dynamiques JS
function t(key) {
    const translations = window.i18n[currentLang] || window.i18n['en'];
    return translations[key] || key;
}

// Apply language in all HTML
function applyLanguage(lang) {
    currentLang = lang;
    const translations = window.i18n[lang] || window.i18n['en'];

    // Translate simple text
    document.querySelectorAll('[data-i18n]').forEach(element => {
        const key = element.getAttribute('data-i18n');
        if (translations[key]) {
            element.innerText = translations[key];
        }
    });

    // Translate text with HTML (liens, <br>, etc.)
    document.querySelectorAll('[data-i18n-html]').forEach(element => {
        const key = element.getAttribute('data-i18n-html');
        if (translations[key]) {
            element.innerHTML = translations[key];
        }
    });

    // --- Tooltips ---
    document.querySelectorAll('[data-i18n-title]').forEach(element => {
        const key = element.getAttribute('data-i18n-title');
        if (translations[key]) {
            element.title = translations[key];
        }
    });
}

const { emit, listen } = window.__TAURI__.event;

let appSettings = {
    language: "en",
    viewer: false,
    stretch: false,
    show_logs_button: false,
    vumeter_preview: true,
    vumeter_program: true,
    viewer_screen: "extended",
    viewer_mode: "fullscreen",
    allow_max_200: true,
    use_custom_startup_vol: false,
    startup_volume: 100,
    default_show_max: false, // false = All, true = Max
    default_max_items: 5,
    default_loop_playlist: true,
    image_display_duration: 5,
    keyboard_space: true,
    keyboard_left_right: false,
    keyboard_up_down: false
};

const previewVideo = document.getElementById('preview-video');
const programVideo = document.getElementById('program-video');

let playlist = [null, null];
let programPath = null;
let viewerVisible = false;
let mpvLaunched = false;
let mpvPaused = true;
let lastMpvTime = 0; 
let lastMasterVolume = 100;
let isMuted = false;
let autoOn = false;
let delayOn = false;
let isDelaying = false;
let isCutting = false;

const previewImage = document.getElementById('preview-image');
const programImage = document.getElementById('program-image');

// Pagination state
let showMode = 'all';
let itemsPerPage = 5;
let currentPage = 1;

const showModeToggle = document.getElementById('show-mode-toggle');
const showMaxInput = document.getElementById('show-max-input');
const pageInfo = document.getElementById('page-info');
const prevPageBtn = document.getElementById('prev-page-btn');
const nextPageBtn = document.getElementById('next-page-btn');

// Helper to check if a file is an image
function isImageFile(path) {
    return /\.(png|jpg|jpeg|bmp|gif|tif|tiff|webp)$/i.test(path);
}
// Helper to check if a file is audio only
function isAudioFile(path) {
    return /\.(mp3|m4a|wav|aif|aiff|flac|ogg|aac)$/i.test(path);
}

// Helper to convert time string (HH:MM:SS, MM:SS, or SS) to total seconds
function timeToSeconds(timeStr) {
    if (!timeStr) return 0;
    const parts = timeStr.split(':').map(Number);
    if (parts.some(isNaN)) return 0;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0];
}

// --- MAIN WINDOW TRUE FULLSCREEN (Windows: F11 | macOS: Cmd+Ctrl+F) ---
document.addEventListener('keydown', (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    
    // Windows/Linux : F11
    // Mac : Cmd + Ctrl + F
    const isFullscreenShortcut = (!isMac && e.key === 'F11') || 
                                 (isMac && e.metaKey && e.ctrlKey && e.key.toLowerCase() === 'f');

    if (isFullscreenShortcut) {
        e.preventDefault();
        invoke('toggle_regie_fullscreen');
    }
});

// FULL SCREEN BUTTON
const regieFullscreenBtn = document.getElementById('regie-fullscreen-btn');
if (regieFullscreenBtn) {
    regieFullscreenBtn.addEventListener('click', () => {
        invoke('toggle_regie_fullscreen');
    });
}

// --- SYSTEM TIME ---
setInterval(() => {
    document.getElementById('system-time').innerText = new Date().toLocaleTimeString();
}, 1000);

// --- VOLUME ---
const volumeSlider = document.getElementById('volume-slider');
const volumeIcon = document.getElementById('volume-icon');
const muteBtn = document.getElementById('mute-btn');
const programPlayBtn = document.getElementById('program-play-btn');

function updateMuteUI(muted) {
    const icon = muted ? '🔇' : '🔊';
    muteBtn.innerText = icon;
    volumeIcon.innerText = icon;
    muteBtn.classList.toggle('btn-blue', !muted);
    muteBtn.classList.toggle('btn-gray', muted);
    volumeSlider.classList.toggle('muted', muted);
}

volumeSlider.addEventListener('input', (e) => {
    let vol = parseFloat(e.target.value);
    lastMasterVolume = vol;
    
    if (vol > 97 && vol < 103) {
        vol = 100;
        volumeSlider.value = vol;
    }
    
    document.getElementById('volume-percent').value = vol;
    
    let newMutedState = (vol === 0);
    if (newMutedState !== isMuted) {
        isMuted = newMutedState;
        updateMuteUI(isMuted);
        if (mpvLaunched) {
            invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "mute", isMuted] }) });
        }
    }

    if (mpvLaunched) {
        invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "volume", vol] }) });
    }

    document.querySelectorAll('.row-options.visible').forEach(optPanel => {
        const toggle = optPanel.querySelector('.opt-vol-toggle');
        const vInput = optPanel.querySelector('.opt-volume');
        if (toggle && !toggle.checked && vInput) {
            vInput.value = vol;
        }
    });
});

// MANUAL VOLUME INPUT
document.getElementById('volume-percent').addEventListener('input', (e) => {
    let val = parseInt(e.target.value);
    if (isNaN(val)) return;
    
    // Limit according to settings
    let maxAllowed = appSettings.allow_max_200 ? 200 : 100;
    
    // Block negative values and over settings max
    val = Math.max(0, Math.min(maxAllowed, val));
    
    if (parseInt(e.target.value) !== val) {
        e.target.value = val;
    }
    
    volumeSlider.value = val;
    lastMasterVolume = val;
    
    let newMutedState = (val === 0);
    if (newMutedState !== isMuted) {
        isMuted = newMutedState;
        updateMuteUI(isMuted);
        if (mpvLaunched) invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "mute", isMuted] }) });
    }

    if (mpvLaunched) {
        invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "volume", val] }) });
    }
});

// --- MUTE (Block 2 Button & Block 1 Icon) ---
function toggleMute() {
    if (mpvLaunched) {
        isMuted = !isMuted;
        updateMuteUI(isMuted);
        invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "mute", isMuted] }) });
        
        // If user unmutes via button, and slider is at 0, put it back to 100
        if (!isMuted && parseFloat(volumeSlider.value) === 0) {
            volumeSlider.value = 100;
            lastMasterVolume = 100;
            document.getElementById('volume-percent').value = 100; // <-- MODIFIÉ ICI
            invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "volume", 100] }) });
        }
    }
}

muteBtn.addEventListener('click', toggleMute);
volumeIcon.addEventListener('click', toggleMute);
updateMuteUI(false); 

// --- AUDIO VU METERS (Canvas + RMS) ---
let audioCtx = null;

function initAudioAnalyser(videoEl) {
    if (!audioCtx) {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    if (!videoEl._sourceNode) {
        try {
            videoEl.crossOrigin = "anonymous";
            videoEl.muted = false;
            videoEl.volume = 1.0;

            let source = audioCtx.createMediaElementSource(videoEl);
            let splitter = audioCtx.createChannelSplitter(2);
            source.connect(splitter);
            
            let analyserL = audioCtx.createAnalyser();
            analyserL.fftSize = 1024;
            splitter.connect(analyserL, 0);
            
            let analyserR = audioCtx.createAnalyser();
            analyserR.fftSize = 1024;
            splitter.connect(analyserR, 1);
            
            // GainNode = 0 prevent sound to go to speakers
            let silentGain = audioCtx.createGain();
            silentGain.gain.value = 0.0;
            source.connect(silentGain);
            silentGain.connect(audioCtx.destination);
            
            videoEl._analyserL = analyserL;
            videoEl._analyserR = analyserR;
            videoEl._sourceNode = source; 
        } catch(e) {
            console.error("Audio API Error:", e);
        }
    }
}

// Decibels level (Peak)
function getLevel(analyser) {
    if(!analyser) return 0;
    
    let data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    
    // max gain (Peak)
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
        let amplitude = Math.abs((data[i] - 128) / 128);
        if (amplitude > peak) {
            peak = amplitude;
        }
    }
    
    // convert Peak in decibels (dB)
    let db = 20 * Math.log10(peak + 0.00001);
    
    // -60 dB = 0% | 0 dB = 100%
    let minDb = -60;
    let maxDb = 0;
    
    if (db < minDb) return 0;
    if (db > maxDb) return 100;
    
    let percentage = ((db - minDb) / (maxDb - minDb)) * 100;
    
    return percentage;
}

// Peak Hold
let prevPeakL = {p: 0, prog: 0};
let prevPeakR = {p: 0, prog: 0};

function drawVUMeter(canvasId, levelL, levelR, isPreview) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    
    if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
        canvas.width = canvas.offsetWidth;
        canvas.height = canvas.offsetHeight;
    }
    
    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    if (isMuted) return;

    const barW = w / 2 - 1;
    const gap = 2;
    
    let peakObj = isPreview ? prevPeakL : prevPeakR;
    
    // Draw lef Canal
    drawBar(ctx, 0, h, barW, levelL, peakObj);
    // Draw right Canal
    drawBar(ctx, barW + gap, h, barW, levelR, peakObj);
}

function drawBar(ctx, x, h, w, level, peakObj) {
    if (level > peakObj.peak) {
        peakObj.peak = level;
    } else {
        peakObj.peak -= 1.5; 
        if (peakObj.peak < 0) peakObj.peak = 0;
    }

    let barH = (level / 100) * h;
    let y = h - barH;

    // Color gradient from dB
    let gradient = ctx.createLinearGradient(0, h, 0, 0);
    // Green (till -6 dB -> 90%)
    gradient.addColorStop(0.00, "#00e600");
    gradient.addColorStop(0.91, "#00e600");
    // Yellow (from -6 to -3 dB -> 90% to 95%)
    gradient.addColorStop(0.92, "#ccff00");
    gradient.addColorStop(0.98, "#ccff00");
    // Red (from -3 to 0 dB -> 95% to 100%)
    gradient.addColorStop(0.99, "#ff0000");
    gradient.addColorStop(1.00, "#990000");
    
    ctx.fillStyle = gradient;
    ctx.fillRect(x, y, w, barH);

    // Draw Peak Hold in white
    let peakY = h - (peakObj.peak / 100) * h;
    ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
    ctx.fillRect(x, peakY, w, 2);
}

function updateVUMeters() {
    requestAnimationFrame(updateVUMeters);
    
    let pL = 0, pR = 0, progL = 0, progR = 0;

    if (previewVideo._analyserL && !previewVideo.paused) {
        pL = getLevel(previewVideo._analyserL);
        pR = getLevel(previewVideo._analyserR);
    }
    if (programVideo._analyserL && !programVideo.paused) {
        progL = getLevel(programVideo._analyserL);
        progR = getLevel(programVideo._analyserR);
    }

    drawVUMeter('preview-vu-canvas', pL, pR, true);
    drawVUMeter('program-vu-canvas', progL, progR, false);
}

updateVUMeters();

// Reset audio at launch
document.addEventListener('click', () => {
    if (!previewVideo._sourceNode) initAudioAnalyser(previewVideo);
    if (!programVideo._sourceNode) initAudioAnalyser(programVideo);
}, { once: true });

// --- PLAY/PAUSE BUTTON COLORS ---
function updatePlayPauseUI(isPaused) {
    programPlayBtn.innerText = isPaused ? '⏸' : '▶';
    programPlayBtn.classList.toggle('btn-blue', !isPaused);
    programPlayBtn.classList.toggle('btn-gray', isPaused);
}
updatePlayPauseUI(true);

// --- FULL SCREEN mpv ---
let isFullscreen = false;

const fullscreenBtn = document.getElementById('fullscreen-btn');
function updateFullscreenUI(active) {
    fullscreenBtn.classList.toggle('btn-blue', active);
    fullscreenBtn.classList.toggle('btn-gray', !active);
}
updateFullscreenUI(false);

fullscreenBtn.addEventListener('click', async () => {
    if (!mpvLaunched) return;
    isFullscreen = !isFullscreen;
    updateFullscreenUI(isFullscreen);
    await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "fullscreen", isFullscreen] }) });
});

// --- TIME FORMATTING ---
function formatHHMMSS(seconds) {
    if (isNaN(seconds) || seconds < 0) seconds = 0;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

let previewDuration = 0;
let programDuration = 0;

async function loadSources() {
    invoke('pick_video_files');
}

// ------------------------------
// --- PLAYLIST ---
// ------------------------------

listen('files-picked', async (event) => {
    const paths = event.payload;
    if (!paths || paths.length === 0) return;

    // 1. Playlist loop
    for (const filePath of paths) {
        const videoData = {
            path: filePath,
            filename: filePath.split('\\').pop().split('/').pop(),
            duration: 0,
            is_4k: false,
            is_hevc: false,
            is_hdr: false,
            is_image: isImageFile(filePath),
            is_audio: isAudioFile(filePath),
            start_time: "00:00:00",
            stop_time: "00:00:00",
            custom_timing: false,
            custom_volume: null
        };

        if (playlist[1] === null) {
            playlist[1] = videoData;
        } else {
            playlist.push(videoData);
        }
    }
    
    // 2. Update
    renderPlaylist();
    loadPreviewIfReady();

    // 3. ASK RUST TO READ VIDEO METADATA WITH FFPROBE
    for (let i = 0; i < playlist.length; i++) {
        if (playlist[i] && playlist[i].duration === 0) {
            try {
                const jsonStr = await invoke('get_video_metadata', { path: playlist[i].path });
                                const meta = JSON.parse(jsonStr);
                const stream = meta.streams && meta.streams[0] ? meta.streams[0] : {};
                
                // Check timing
                const dur = parseFloat(meta.format?.duration || 0);
                
                if (!isNaN(dur) && dur > 0) {
                    playlist[i].duration = dur;
                    playlist[i].stop_time = formatHHMMSS(dur);
                }
                
                // Badges 4K/HDR for videos only
                if (meta.streams && meta.streams[0]) {
                    const width = parseInt(stream.width) || 0;
                    const height = parseInt(stream.height) || 0;
                    const codec = (stream.codec_name || "").toLowerCase();
                    const transfer = (stream.color_transfer || "").toLowerCase();
                    const primaries = (stream.color_primaries || "").toLowerCase();
                    
                    playlist[i].is_4k = width >= 3840 || height >= 2160;
                    playlist[i].is_hevc = codec.includes("hevc") || codec.includes("265");
                    playlist[i].is_hdr = primaries.includes("bt2020") || 
                                         transfer.includes("smpte2084") || 
                                         transfer.includes("arib-std-b67") || 
                                         transfer.includes("smpte2094");   
                }
            } catch(e) {
                console.error(`Failed to get metadata for ${playlist[i].path}`, e);
            }
            renderPlaylist();
        }
    }
});

// --- CONSTRUCT PLAYLIST ---

function renderPlaylist() {
    const container = document.getElementById('playlist-container');
    container.innerHTML = '';

    let indicesToRender = [];
    if (showMode === 'max') {
        if (playlist.length > 0) indicesToRender.push(0);
        let queueStart = 1 + (currentPage - 1) * itemsPerPage;
        let queueEnd = Math.min(queueStart + itemsPerPage, playlist.length);
        for (let i = queueStart; i < queueEnd; i++) {
            indicesToRender.push(i);
        }
    } else {
        for (let i = 0; i < playlist.length; i++) {
            indicesToRender.push(i);
        }
    }

    for (let idx = 0; idx < indicesToRender.length; idx++) {
        const i = indicesToRender[idx];
        const item = playlist[i];
        const row = document.createElement('div');
        row.className = 'playlist-row';
        
        if (i === 0) row.classList.add('program');
        else if (i === 1) row.classList.add('preview');
        else row.classList.add('queue');

        if (!item) {
            row.innerHTML = `
                <div class="row-main">
                    <span class="num">${i}</span>
                    <div class="arrows"></div>
                    <div class="move-btns"></div>
                    <span class="duration">--:--</span>
                    <span class="filename">${i === 0 ? t('empty_program') : t('empty_preview')}</span>
                </div>
                `;
            container.appendChild(row);
            continue;
        }

        row.innerHTML = `
            <div class="row-main" data-index="${i}">
                <span class="num">${i}</span>
                <div class="arrows">
                    <button class="up-btn" ${i <= 1 ? 'disabled' : ''}>▲</button>
                    <button class="down-btn" ${i <= 0 ? 'disabled' : ''}>▼</button>
                </div>
                <div class="move-btns">
                    <button class="top-btn" ${i <= 2 ? 'disabled' : ''}>⤒</button>
                    <button class="bottom-btn" ${i <= 1 || i === playlist.length - 1 ? 'disabled' : ''}>⤓</button>
                </div>
                <span class="duration">${formatHHMMSS(item.custom_timing ? (timeToSeconds(item.stop_time) - timeToSeconds(item.start_time)) : item.duration)}</span>
                <span class="filename">${item.filename}</span>
                <div class="badges-container">
                    ${item.is_4k ? '<span class="vpc-badge">4K</span>' : ''}
                    ${item.is_hevc ? '<span class="vpc-badge">HEVC</span>' : ''}
                    ${item.is_hdr ? '<span class="vpc-badge">HDR</span>' : ''}
                    ${item.is_image ? '<span class="vpc-badge">IMG</span>' : ''}
                    ${item.is_audio ? '<span class="vpc-badge">AUDIO</span>' : ''}
                </div>
                <button class="opts-btn ${item.custom_timing || item.custom_volume !== null ? 'opts-active' : ''}">☰</button>
                <button class="remove-btn" ${i === 0 ? 'disabled' : ''}>🗑️</button>
            </div>
            <div class="row-options">
                <div class="opt-group">
                    <span><strong>${t('opt_timing_label')}</strong>${t('opt_default')}</span>
                    <label class="switch">
                        <input type="checkbox" class="opt-timing-toggle" ${item.custom_timing ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                    <span>${t('opt_start_at')}</span>
                    <input type="text" class="opt-start" value="${item.start_time || '00:00:00'}">
                    <span>${t('opt_end_at')}</span>
                    <input type="text" class="opt-stop" value="${item.stop_time || '00:00:00'}">
                </div>
                <div class="opt-group">
                    <span><strong>${t('opt_volume_label')}</strong>${t('opt_default')}</span>
                    <label class="switch">
                        <input type="checkbox" class="opt-vol-toggle" ${item.custom_volume !== null ? 'checked' : ''}>
                        <span class="slider"></span>
                    </label>
                    <input type="number" class="opt-volume" min="0" max="200" value="${item.custom_volume !== null ? item.custom_volume : parseFloat(volumeSlider.value)}">%
                </div>
                <div class="opt-actions">
                    <button class="opt-cancel">${t('cancel_button')}</button>
                    <button class="opt-apply">${t('apply_button')}</button>
                </div>
            </div>
        `;

        if (i > 1) {
            row.querySelector('.up-btn').addEventListener('click', () => moveItem(i, -1));
            row.querySelector('.top-btn').addEventListener('click', () => moveToTop(i));
            row.querySelector('.bottom-btn').addEventListener('click', () => moveToBottom(i));
        }
        if (i > 0) {
            row.querySelector('.down-btn').addEventListener('click', () => moveItem(i, 1));
            row.querySelector('.remove-btn').addEventListener('click', () => removeItem(i));
        }

        const optsBtn = row.querySelector('.opts-btn');
        const rowOptions = row.querySelector('.row-options');
        if (optsBtn) {
            optsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                rowOptions.classList.toggle('visible');
                // Sync volume input with Master Volume if default
                const toggle = row.querySelector('.opt-vol-toggle');
                const vInput = row.querySelector('.opt-volume');
                if (toggle && !toggle.checked && vInput) {
                    vInput.value = parseFloat(volumeSlider.value);
                }
            });
        }

        const applyBtn = row.querySelector('.opt-apply');
        const cancelBtn = row.querySelector('.opt-cancel');
        const startInput = row.querySelector('.opt-start');
        const stopInput = row.querySelector('.opt-stop');
        const volInput = row.querySelector('.opt-volume');
        const volToggle = row.querySelector('.opt-vol-toggle');
        const timingToggle = row.querySelector('.opt-timing-toggle');

        // Toggle TIMING
        if (timingToggle) {
            timingToggle.addEventListener('change', () => {
                if (!timingToggle.checked) {
                    // Reset if default
                    startInput.value = "00:00:00";
                    stopInput.value = formatHHMMSS(playlist[i].duration);
                }
            });
        }

         // Toggle VOLUME
        if (volToggle) {
            volToggle.addEventListener('change', () => {
                if (volToggle.checked) {
                    // ON (Blue): Freeze current Master Volume into the input
                    volInput.value = parseFloat(volumeSlider.value);
                } else {
                    // OFF (Gray/Default): Update input to current Master Volume
                    volInput.value = parseFloat(volumeSlider.value);
                }
            });
        }

        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                // Timing
                if (timingToggle.checked) {
                    playlist[i].custom_timing = true;
                    playlist[i].start_time = startInput.value;
                    playlist[i].stop_time = stopInput.value;
                } else {
                    playlist[i].custom_timing = false;
                    playlist[i].start_time = "00:00:00";
                    playlist[i].stop_time = formatHHMMSS(playlist[i].duration);
                }

                // Volume
                if (volToggle.checked) {
                    playlist[i].custom_volume = parseInt(volInput.value) || 100;
                } else {
                    playlist[i].custom_volume = null;
                }

                rowOptions.classList.remove('visible');
                // Update only this row's duration
                row.querySelector('.duration').innerText = formatHHMMSS(playlist[i].custom_timing ? (timeToSeconds(playlist[i].stop_time) - timeToSeconds(playlist[i].start_time)) : playlist[i].duration);
                // update color button ☰ to blue
                const hasOpts = playlist[i].custom_timing || playlist[i].custom_volume !== null;
                optsBtn.classList.toggle('opts-active', hasOpts);
            });
        }
        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                timingToggle.checked = playlist[i].custom_timing;
                volToggle.checked = playlist[i].custom_volume !== null;
                
                startInput.value = playlist[i].start_time || '00:00:00';
                stopInput.value = playlist[i].stop_time || formatHHMMSS(playlist[i].duration);
                volInput.value = playlist[i].custom_volume !== null ? playlist[i].custom_volume : parseFloat(volumeSlider.value);
                
                rowOptions.classList.remove('visible');
                
                // update color button ☰ to white
                const hasOpts = playlist[i].custom_timing || playlist[i].custom_volume !== null;
                optsBtn.classList.toggle('opts-active', hasOpts);
            });
        }

        // --- DRAG & DROP LOGIC ---
        const rowMain = row.querySelector('.row-main');
        let isDragging = false;
        let startY = 0;
        let dragGhost = null;

        if (i > 0) {
            rowMain.addEventListener('mousedown', (e) => {
                if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT') return;
                isDragging = true;
                startY = e.clientY;
                rowMain.style.cursor = 'grabbing';
            });

            document.addEventListener('mousemove', (e) => {
                if (!isDragging) return;
                if (Math.abs(e.clientY - startY) > 5 && !dragGhost) {
                    rowMain.classList.add('dragging');
                    dragGhost = rowMain.cloneNode(true);
                    dragGhost.style.position = 'absolute';
                    dragGhost.style.top = '-9999px';
                    dragGhost.style.left = '-9999px';
                    dragGhost.style.width = rowMain.offsetWidth + 'px';
                    dragGhost.style.opacity = '0.8';
                    dragGhost.style.pointerEvents = 'none';
                    dragGhost.style.background = '#2D2E2D';
                    dragGhost.style.border = '1px solid #3399ff';
                    dragGhost.style.zIndex = '9999';
                    document.body.appendChild(dragGhost);
                }

                if (dragGhost) {
                    dragGhost.style.left = e.clientX + 'px';
                    dragGhost.style.top = e.clientY + 'px';
                    
                    const elements = document.elementsFromPoint(e.clientX, e.clientY);
                    let hoveredRow = null;
                    for (let el of elements) {
                        if (el.classList.contains('playlist-row')) {
                            hoveredRow = el;
                            break;
                        }
                    }

                    document.querySelectorAll('.row-main').forEach(r => r.classList.remove('drag-over'));
                    if (hoveredRow && hoveredRow !== row) {
                        const hoveredIndex = parseInt(hoveredRow.querySelector('.row-main').dataset.index);
                        if (hoveredIndex > 0) {
                            hoveredRow.querySelector('.row-main').classList.add('drag-over');
                        }
                    }
                }
            });

            document.addEventListener('mouseup', (e) => {
                if (!isDragging) return;
                isDragging = false;
                rowMain.style.cursor = 'grab';
                
                if (dragGhost) {
                    dragGhost.remove();
                    dragGhost = null;
                    
                    const elements = document.elementsFromPoint(e.clientX, e.clientY);
                    let dropTargetRow = null;
                    for (let el of elements) {
                        if (el.classList.contains('playlist-row')) {
                            dropTargetRow = el;
                            break;
                        }
                    }

                    if (dropTargetRow) {
                        const targetIndex = parseInt(dropTargetRow.querySelector('.row-main').dataset.index);
                        if (targetIndex > 0 && targetIndex !== i) {
                            const [movedItem] = playlist.splice(i, 1);
                            let insertIndex = targetIndex;
                            if (targetIndex > i) {
                                insertIndex = targetIndex - 1;
                            }
                            playlist.splice(insertIndex, 0, movedItem);
                            renderPlaylist();
                            loadPreviewIfReady();
                        }
                    }
                }
                rowMain.classList.remove('dragging');
                document.querySelectorAll('.row-main').forEach(r => r.classList.remove('drag-over'));
            });
        }
        container.appendChild(row);
    }
    updatePaginationUI();
}

// --- PAGINATION LOGIC ---
function updatePaginationUI() {
    if (showMode === 'all') {
        if(showModeToggle) showModeToggle.checked = false;
        if(showMaxInput) showMaxInput.disabled = true;
        if(pageInfo) pageInfo.innerText = `${t('page_label')} 1/1`;
        if(prevPageBtn) prevPageBtn.disabled = true;
        if(nextPageBtn) nextPageBtn.disabled = true;
    } else {
        if(showModeToggle) showModeToggle.checked = true;
        if(showMaxInput) showMaxInput.disabled = false;
        const itemsToPaginate = Math.max(0, playlist.length - 1);
        const totalPages = Math.max(1, Math.ceil(itemsToPaginate / itemsPerPage));
        if (currentPage > totalPages) currentPage = totalPages;
        if (currentPage < 1) currentPage = 1;
        if(pageInfo) pageInfo.innerText = `${t('page_label')} ${currentPage}/${totalPages}`;
        if(prevPageBtn) prevPageBtn.disabled = (currentPage <= 1);
        if(nextPageBtn) nextPageBtn.disabled = (currentPage >= totalPages);
    }
}

if (showModeToggle) {
    showModeToggle.addEventListener('change', () => {
        showMode = showModeToggle.checked ? 'max' : 'all';
        currentPage = 1;
        renderPlaylist();
    });
}
if (showMaxInput) {
    showMaxInput.addEventListener('change', (e) => {
        itemsPerPage = Math.max(1, parseInt(e.target.value) || 5);
        currentPage = 1;
        renderPlaylist();
    });
}
if (prevPageBtn) {
    prevPageBtn.addEventListener('click', () => {
        if (currentPage > 1) { currentPage--; renderPlaylist(); }
    });
}
if (nextPageBtn) {
    nextPageBtn.addEventListener('click', () => {
        const totalPages = Math.max(1, Math.ceil(playlist.length / itemsPerPage));
        if (currentPage < totalPages) { currentPage++; renderPlaylist(); }
    });
}

function moveItem(index, direction) {
    const newIndex = index + direction;
    if (newIndex < 1) return;
    [playlist[index], playlist[newIndex]] = [playlist[newIndex], playlist[index]];
    renderPlaylist();
    loadPreviewIfReady();
}

function moveToTop(index) {
    if (index <= 2) return;
    const [item] = playlist.splice(index, 1);
    playlist.splice(2, 0, item);
    renderPlaylist();
    loadPreviewIfReady();
}

function moveToBottom(index) {
    if (index <= 1) return;
    const [item] = playlist.splice(index, 1);
    playlist.push(item);
    renderPlaylist();
    loadPreviewIfReady();
}

function removeItem(index) {
    if (index <= 0) return;
    playlist.splice(index, 1);
    if (playlist.length < 2) playlist.push(null);
    renderPlaylist();
    loadPreviewIfReady();
}

// --- SAVE / LOAD PLAYLIST ---
document.getElementById('save-playlist-btn').addEventListener('click', async () => {
    const saveData = {
        show_mode: showMode,
        items_per_page: itemsPerPage,
        loop_playlist: document.getElementById('loop-playlist-toggle').checked,
        playlist: playlist.map(item => {
            if (!item) return null;
            
            // If path only
            let saveItem = { path: item.path };
            
            // Add options
            if (item.custom_timing) {
                saveItem.start_time = item.start_time;
                saveItem.stop_time = item.stop_time;
            }
            
            if (item.custom_volume !== null) {
                saveItem.custom_volume = item.custom_volume;
            }
            
            return saveItem;
        }).filter(item => item !== null)
    };

    await invoke('save_playlist', { content: JSON.stringify(saveData, null, 2), title: t('dialog_save_playlist') });
});

document.getElementById('load-playlist-btn').addEventListener('click', async () => {
    // Ask Rust to prompt "open file"
    await invoke('load_playlist', { title: t('dialog_load_playlist') });
});

// Listen to Rust return
listen('playlist-loaded', async (event) => {
    try {
        const loadedData = JSON.parse(event.payload);
        
        // 1. Reset UI after load
        showMode = loadedData.show_mode || 'all';
        itemsPerPage = loadedData.items_per_page || 5;
        
        const loopToggle = document.getElementById('loop-playlist-toggle');
        if (loopToggle) loopToggle.checked = loadedData.loop_playlist !== undefined ? loadedData.loop_playlist : true;
        
        // Update pagination
        if (showModeToggle) showModeToggle.checked = (showMode === 'max');
        if (showMaxInput) {
            showMaxInput.value = itemsPerPage;
            showMaxInput.disabled = (showMode !== 'max');
        }
        
        // 2. Add preloaded sources
        for (const item of loadedData.playlist) {
            if (!item || !item.path) continue;
            
            const isCustomTiming = (item.start_time !== undefined && item.stop_time !== undefined);
            
            const videoData = {
                path: item.path,
                filename: item.path.split('\\').pop().split('/').pop(),
                duration: 0,
                isUnsupported: false, is_4k: false, is_hevc: false, is_hdr: false,
                is_image: isImageFile(item.path),
                is_audio: isAudioFile(item.path),
                start_time: item.start_time || "00:00:00",
                stop_time: item.stop_time || "00:00:00",
                custom_timing: isCustomTiming,
                custom_volume: item.custom_volume !== undefined ? item.custom_volume : null
            };

            if (playlist[1] === null) {
                playlist[1] = videoData;
            } else {
                playlist.push(videoData);
            }
        }

        // 3. Update UI
        renderPlaylist();
        loadPreviewIfReady();

        // 4. Ask FFPROBE for timings & badges
        for (let i = 0; i < playlist.length; i++) {
            if (playlist[i] && playlist[i].duration === 0) {
                try {
                    const jsonStr = await invoke('get_video_metadata', { path: playlist[i].path });
                    const meta = JSON.parse(jsonStr);
                    
                    const stream = meta.streams && meta.streams[0] ? meta.streams[0] : {};
                    const dur = parseFloat(meta.format?.duration || 0);
                    
                    if (!isNaN(dur) && dur > 0) {
                        playlist[i].duration = dur;
                        if (!playlist[i].custom_timing) {
                            playlist[i].stop_time = formatHHMMSS(dur);
                        }
                    }
                    
                    if (meta.streams && meta.streams[0]) {
                        const width = parseInt(stream.width) || 0;
                        const height = parseInt(stream.height) || 0;
                        const codec = (stream.codec_name || "").toLowerCase();
                        const transfer = (stream.color_transfer || "").toLowerCase();
                        const primaries = (stream.color_primaries || "").toLowerCase();
                        
                        playlist[i].is_4k = width >= 3840 || height >= 2160;
                        playlist[i].is_hevc = codec.includes("hevc") || codec.includes("265");
                        playlist[i].is_hdr = primaries.includes("bt2020") || transfer.includes("smpte2084") || transfer.includes("arib-std-b67") || transfer.includes("smpte2094");
                    }
                } catch(e) {
                    console.error(`Failed to get metadata for ${playlist[i].path}`, e);
                }
                renderPlaylist();
            }
        }
        
        console.log("Playlist loaded and appended successfully!");
    } catch(e) {
        console.error("Failed to parse loaded playlist", e);
    }
});

function loadPreviewIfReady() {
    const previewItem = playlist[1];
    if (previewItem) {
        document.getElementById('preview-name').innerText = previewItem.filename;
        document.getElementById('preview-play-btn').innerText = '▶';
        
        let pStart = timeToSeconds(previewItem.start_time);
        let pStop = timeToSeconds(previewItem.stop_time) || previewItem.duration;
        previewDuration = pStop - pStart;

        document.getElementById('preview-elapsed').innerText = formatHHMMSS(pStart);
        document.getElementById('preview-remaining').innerText = "-" + formatHHMMSS(previewDuration);
        document.getElementById('preview-scrub').value = 0;
        
        if (isImageFile(previewItem.path)) {
            previewVideo.style.display = 'none';
            previewVideo.src = '';
            previewImage.src = convertFileSrc(previewItem.path);
            previewImage.style.display = 'block';
        } else {
            previewImage.style.display = 'none';
            previewImage.src = '';
            previewVideo.style.display = 'block';
            previewVideo.src = convertFileSrc(previewItem.path);
            previewVideo.load();
            
            // FIX 3: Seek to Start Time as soon as metadata is loaded
            previewVideo.onloadedmetadata = () => {
                if (pStart > 0) {
                    previewVideo.currentTime = pStart;
                }
            };
        }
    } else {
        previewVideo.src = '';
        previewImage.src = '';
        previewVideo.style.display = 'block';
        previewImage.style.display = 'none';
        document.getElementById('preview-name').innerText = t('no_source');
        previewDuration = 0;
        document.getElementById('preview-elapsed').innerText = "00:00:00";
        document.getElementById('preview-remaining').innerText = "00:00:00";
    }
}

// --- PREVIEW TRANSPORT LISTENERS ---
previewVideo.addEventListener('timeupdate', () => {
    const previewItem = playlist[1];
    if (!previewItem || !previewVideo.duration) return;
    
    const t = previewVideo.currentTime;
    let pStart = timeToSeconds(previewItem.start_time);
    let pStop = timeToSeconds(previewItem.stop_time) || previewItem.duration;
    
    document.getElementById('preview-elapsed').innerText = formatHHMMSS(t);
    document.getElementById('preview-remaining').innerText = "-" + formatHHMMSS(pStop - t);
    
    if (pStop > pStart) {
        document.getElementById('preview-scrub').value = Math.max(0, Math.min(100, ((t - pStart) / (pStop - pStart)) * 100));
    }

    if (t >= pStop) {
        previewVideo.pause();
        document.getElementById('preview-play-btn').innerText = '▶';
    }
});

document.getElementById('preview-scrub').addEventListener('input', (e) => {
    const previewItem = playlist[1];
    if (previewItem) {
        let pStart = timeToSeconds(previewItem.start_time);
        let pStop = timeToSeconds(previewItem.stop_time) || previewItem.duration;
        const percent = parseFloat(e.target.value);
        previewVideo.currentTime = pStart + (percent / 100) * (pStop - pStart);
    }
});

// --- PREVIEW CONTROLS ---
document.getElementById('preview-play-btn').addEventListener('click', () => {
    if (previewVideo.paused) {
        previewVideo.play();
        document.getElementById('preview-play-btn').innerText = '⏸';
    } else {
        previewVideo.pause();
        document.getElementById('preview-play-btn').innerText = '▶';
    }
});

// --- DELAY LOGIC ---
async function performDelay() {
    isDelaying = true;
    const delayVal = parseFloat(document.getElementById('delay-input').value) || 1.0;
    
    previewVideo.style.display = 'block'; 
    programVideo.style.display = 'none';
    programVideo.src = '';
    programImage.style.display = 'none';
    programImage.src = '';
    document.getElementById('program-name').innerText = t('black_screen_delay');
    
    if (mpvLaunched) {
        let blackPath = await invoke('get_black_screen_path');
        await invoke('mpv_command', { command: JSON.stringify({ command: ["loadfile", blackPath, "replace"] }) });
        await new Promise(r => setTimeout(r, 50));
        await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "pause", true] }) });
    }
    
    await new Promise(r => setTimeout(r, delayVal * 1000));
    isDelaying = false;
}

// --- TRANSITIONS (CUT) ---
async function performCut() {
    if (isCutting) return; 
    isCutting = true;

    const previewItem = playlist[1];
    if (!previewItem) {
        isCutting = false;
        return;
    }

    const loopToQueue = document.getElementById('loop-playlist-toggle').checked;
    const oldProgram = playlist[0];

    // 1. Update playlist in memory
    playlist[0] = previewItem;
    programPath = previewItem.path;
    
    if (playlist.length > 2) {
        playlist[1] = playlist[2];
        playlist.splice(2, 1);
    } else {
        playlist[1] = null;
    }

    if (loopToQueue && oldProgram) {
        if (playlist[1] === null) {
            playlist[1] = oldProgram;
        } else {
            playlist.push(oldProgram);
        }
    }

    // 2. All variables before ask Rust
    document.getElementById('program-name').innerText = previewItem.filename;
    
    let pStart = timeToSeconds(previewItem.start_time);
    let pStop = timeToSeconds(previewItem.stop_time) || previewItem.duration;
    programDuration = pStop - pStart;

    document.getElementById('program-elapsed').innerText = formatHHMMSS(pStart);
    document.getElementById('program-remaining').innerText = "-" + formatHHMMSS(programDuration);
    document.getElementById('program-scrub').value = 0;
    
    let startTimeSec = timeToSeconds(previewItem.start_time);
    let vidVol = previewItem.custom_volume !== null ? previewItem.custom_volume : lastMasterVolume;

    // 3. Update monitor HTML Program
    if (isImageFile(programPath)) {
        programVideo.style.display = 'none';
        programVideo.src = '';
        programImage.src = convertFileSrc(programPath);
        programImage.style.display = 'block';
    } else {
        programImage.style.display = 'none';
        programImage.src = '';
        programVideo.style.display = 'block';
        programVideo.src = convertFileSrc(programPath);
        
        programVideo.onloadedmetadata = () => {
            if (startTimeSec > 0) {
                programVideo.currentTime = startTimeSec;
            }
        };
        programVideo.play();
    }
    
    // 4. Fro mpv to Rust
     if (mpvLaunched) {
        // Guive all to Rust
        await invoke('perform_mpv_cut', {
            programPath: programPath,
            startTime: startTimeSec,
            volume: vidVol,
            isMuted: isMuted,
            loopA: pStart,
            loopB: pStop,
            isLooping: loopOn
        });
        
        // Update UI
        volumeSlider.value = vidVol;
        document.getElementById('volume-percent').value = vidVol;
        updateMuteUI(isMuted);

        mpvPaused = false;
    }
    
    updatePlayPauseUI(false);

    // 5. Update UI off Playlist & Preview
    renderPlaylist();
    previewVideo.src = ''; 
    loadPreviewIfReady();
    
    // 6. Allow next CUT
    setTimeout(() => { isCutting = false; }, 500);
}

// --- CUT ORCHESTRATOR ---
async function triggerCut() {
    if (isCutting || isDelaying) return;
    if (delayOn) await performDelay();
    performCut();
}

document.getElementById('cut-btn').addEventListener('click', triggerCut);

const autoBtn = document.getElementById('auto-btn');
autoBtn.classList.add('btn-gray');
autoBtn.addEventListener('click', () => {
    autoOn = !autoOn;
    autoBtn.classList.toggle('btn-blue', autoOn);
    autoBtn.classList.toggle('btn-gray', !autoOn);
});

const delayBtn = document.getElementById('delay-btn');
delayBtn.classList.add('btn-gray');
delayBtn.addEventListener('click', () => {
    delayOn = !delayOn;
    delayBtn.classList.toggle('btn-blue', delayOn);
    delayBtn.classList.toggle('btn-gray', !delayOn);
});

listen('mpv-ended', () => {
    if (autoOn && !isDelaying && !isCutting) triggerCut();
});

programVideo.addEventListener('ended', () => {
    if (!mpvLaunched && autoOn && !isDelaying && !isCutting) triggerCut();
});

document.getElementById('program-play-btn').addEventListener('click', async () => {
    if (mpvLaunched) {
        await invoke('mpv_command', { command: JSON.stringify({ command: ["cycle", "pause"] }) });
    } else {
        if (programVideo.paused) {
            programVideo.play();
            updatePlayPauseUI(false);
        } else {
            programVideo.pause();
            updatePlayPauseUI(true);
        }
    }
});

document.getElementById('clear-playlist-btn').addEventListener('click', () => {
    if (playlist.length > 2) {
        playlist = playlist.slice(0, 2);
        renderPlaylist();
    }
});

// --- VIEWER TOGGLE & VISIBILITY ---
const toggleViewerBtn = document.getElementById('toggle-viewer-btn');
toggleViewerBtn.classList.add('btn-gray'); 

document.getElementById('toggle-viewer-btn').addEventListener('click', async () => {
    if (!mpvLaunched) {
        // 1. get actual timing in HTML Program
        let currentStartTime = lastMpvTime;
        if (programVideo.src) {
            currentStartTime = programVideo.currentTime;
        }
        
        // 2. get actual pause in HTML Program
        let currentIsPaused = mpvPaused;
        if (programVideo.src) {
            currentIsPaused = programVideo.paused;
        }
        
        // give timing to mpv
        const status = await invoke('toggle_viewer_window', { 
            programPath: programPath || "", 
            startTime: currentStartTime, 
            isPaused: currentIsPaused
        });
        
        if (status === 2) {
            mpvLaunched = true;
            viewerVisible = false;
            isFullscreen = appSettings.viewer_mode === "fullscreen";
            updateFullscreenUI(isFullscreen); 
            
            // Wait 500ms for IPC pipe, then display video
            setTimeout(async () => {
                await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "vo", "gpu"] }) });
                viewerVisible = true;
                toggleViewerBtn.classList.toggle('btn-blue', viewerVisible);
                toggleViewerBtn.classList.toggle('btn-gray', !viewerVisible);
            }, 500);
        }
    } else {
        // 'gpu' = shown --- 'null' = hidden
        if (viewerVisible) {
            await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "vo", "null"] }) });
            viewerVisible = false;
        } else {
            await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "vo", "gpu"] }) });
            viewerVisible = true;
        }
        toggleViewerBtn.classList.toggle('btn-blue', viewerVisible);
        toggleViewerBtn.classList.toggle('btn-gray', !viewerVisible);
    }
});
// If mpv is closed manually
listen('viewer-visibility', (event) => {
    if (!event.payload && mpvLaunched) {
        viewerVisible = false;
        mpvLaunched = false;
        isFullscreen = false;
        updateFullscreenUI(isFullscreen);
        toggleViewerBtn.classList.toggle('btn-blue', viewerVisible);
        toggleViewerBtn.classList.toggle('btn-gray', !viewerVisible);
    }
});

const ccBtn = document.getElementById('cc-btn');
let ccActive = true; 
function updateCCUI(active) {
    ccBtn.classList.toggle('btn-blue', active);
    ccBtn.classList.toggle('btn-gray', !active);
}
updateCCUI(ccActive); 
ccBtn.addEventListener('click', async () => {
    if (mpvLaunched) {
        await invoke('mpv_command', { command: JSON.stringify({ command: ["cycle", "sub-visibility"] }) });
        ccActive = !ccActive;
        updateCCUI(ccActive);
    }
});

// --- LOOP BUTTON ---
const loopBtn = document.getElementById('loop-btn');
let loopOn = false; 

function updateLoopUI(active) {
    loopBtn.classList.toggle('btn-blue', active);
    loopBtn.classList.toggle('btn-gray', !active);
}

loopBtn.addEventListener('click', async () => {
    if (mpvLaunched) {
        loopOn = !loopOn;
        const programItem = playlist[0];
        
        if (loopOn && programItem) {
            // Set A/B points dynamically based on current video's options
            let pStart = timeToSeconds(programItem.start_time);
            let pStop = timeToSeconds(programItem.stop_time) || programItem.duration;
            await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "ab-loop-a", pStart] }) });
            await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "ab-loop-b", pStop] }) });
        } else {
            // Reset A/B loop points to "no" to disable looping
            await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "ab-loop-a", "no"] }) });
            await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "ab-loop-b", "no"] }) });
        }
        updateLoopUI(loopOn);
    }
});

const stretchBtn = document.getElementById('stretch-btn');
let stretchOn = false; 
function updateStretchUI(active) {
    stretchBtn.classList.toggle('btn-blue', active);
    stretchBtn.classList.toggle('btn-gray', !active);
}
stretchBtn.addEventListener('click', async () => {
    if (mpvLaunched) {
        await invoke('mpv_command', { command: JSON.stringify({ command: ["cycle", "keepaspect"] }) });
        stretchOn = !stretchOn;
        updateStretchUI(stretchOn);
    }
});

// =====================================================================
// MASTER/SLAVE SYNC: MPV is Master, HTML Program is Slave
// =====================================================================
listen('mpv-time-update', (event) => {
    const mpvTime = event.payload;
    lastMpvTime = mpvTime; 
    
    const programItem = playlist[0];
    if (programItem) {
        let pStart = timeToSeconds(programItem.start_time);
        let pStop = timeToSeconds(programItem.stop_time) || programItem.duration;
        let effectiveDuration = pStop - pStart;
        
        document.getElementById('program-elapsed').innerText = formatHHMMSS(mpvTime);
        document.getElementById('program-remaining').innerText = "-" + formatHHMMSS(Math.max(0, pStop - mpvTime));
        
        if (effectiveDuration > 0) {
            let scrubVal = ((mpvTime - pStart) / effectiveDuration) * 100;
            document.getElementById('program-scrub').value = Math.max(0, Math.min(100, scrubVal));
        }

        // STOP AT END TIME in MPV
        if (pStop > 0 && mpvTime >= pStop && !mpvPaused && !loopOn) {
            invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "pause", true] }) });
            if (autoOn && !isDelaying && !isCutting) {
                triggerCut();
            }
        }
    }

    if (!programVideo.src) return;
    
    const drift = Math.abs(programVideo.currentTime - mpvTime);
    if (drift > (mpvPaused ? 0.01 : 0.1)) {
        programVideo.currentTime = mpvTime;
    }
});

listen('mpv-pause-update', (event) => {
    mpvPaused = event.payload;
    updatePlayPauseUI(mpvPaused);

    if (!programVideo.src) return;

    // Force HTML PROGRAM to synch with MPV
    if (mpvPaused) {
        programVideo.pause();
    } else {
        programVideo.play().catch(e => console.error("HTML video play blocked:", e));
    }
});

document.getElementById('program-scrub').addEventListener('input', (e) => {
    const programItem = playlist[0];
    if (programItem && mpvLaunched) {
        let pStart = timeToSeconds(programItem.start_time);
        let pStop = timeToSeconds(programItem.stop_time) || programItem.duration;
        const percent = parseFloat(e.target.value);
        const seekTime = pStart + (percent / 100) * (pStop - pStart);
        invoke('mpv_command', { command: JSON.stringify({ command: ["seek", seekTime, "absolute"] }) });
    }
});

// --- ABOUT POPUP ---
const aboutOverlay = document.getElementById('about-overlay');
const aboutCloseBtn = document.getElementById('about-close-btn');

// Open pop up when click on logo
document.getElementById('logo-btn').addEventListener('click', () => {
    aboutOverlay.style.display = 'flex';
});

// Button Close popup
aboutCloseBtn.addEventListener('click', () => {
    aboutOverlay.style.display = 'none';
});

// Close popup window when clicking outside window
aboutOverlay.addEventListener('click', (e) => {
    if (e.target === aboutOverlay) {
        aboutOverlay.style.display = 'none';
    }
});

// --- Open external links (POPUP ABOUT) ---
document.querySelectorAll('#about-overlay a').forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        const url = link.getAttribute('href');
        if (url && url !== '#') {
            invoke('open_external_link', { url: url });
        }
    });
});

// --- SETTINGS POPUP ---
const settingsOverlay = document.getElementById('settings-overlay');
const settingsCancelBtn = document.getElementById('settings-cancel-btn');
const settingsApplyBtn = document.getElementById('settings-apply-btn');

// Open pop up when click on logo
document.getElementById('settings-btn').addEventListener('click', () => {
    settingsOverlay.style.display = 'flex';
});

// Close popup
const closeSettings = () => {
    settingsOverlay.style.display = 'none';
};

settingsCancelBtn.addEventListener('click', closeSettings);

// save SETTINGS when Apply
settingsApplyBtn.addEventListener('click', async () => {
    const langSelect = document.getElementById('setting-language');
    if (langSelect) appSettings.language = langSelect.value;
    applyLanguage(appSettings.language);
    appSettings.viewer = document.getElementById('setting-viewer').checked;
    appSettings.stretch = document.getElementById('setting-stretch').checked;
    appSettings.show_logs_button = document.getElementById('setting-logs-btn').checked;
    appSettings.vumeter_preview = document.getElementById('setting-vumeter-preview').checked;
    appSettings.vumeter_program = document.getElementById('setting-vumeter-program').checked;
    const screenRadio = document.querySelector('input[name="viewer-screen"]:checked');
        if (screenRadio) appSettings.viewer_screen = screenRadio.value;
    const modeRadio = document.querySelector('input[name="viewer-mode"]:checked');
        if (modeRadio) appSettings.viewer_mode = modeRadio.value;
    appSettings.allow_max_200 = document.getElementById('setting-max-vol').checked;
    
    // Volume at startup
    appSettings.use_custom_startup_vol = document.getElementById('setting-default-vol-toggle').checked;
    let defVol = parseInt(document.getElementById('setting-default-vol-input').value);
    if (isNaN(defVol)) defVol = 100;
    let maxAllowed = appSettings.allow_max_200 ? 200 : 100;
    appSettings.startup_volume = Math.max(0, Math.min(maxAllowed, defVol));

    // Show playlist item by default
    appSettings.default_show_max = document.getElementById('setting-default-show').checked;
    let maxItems = parseInt(document.getElementById('setting-default-max').value);
    if (isNaN(maxItems) || maxItems < 1) maxItems = 5;
    if (maxItems > 50) maxItems = 50;
    appSettings.default_max_items = maxItems;

    appSettings.default_loop_playlist = document.getElementById('setting-default-loop').checked;

    let imgDur = parseInt(document.getElementById('setting-image-duration').value);
    if (isNaN(imgDur) || imgDur < 1) imgDur = 5;
    if (imgDur > 999) imgDur = 999;
    appSettings.image_display_duration = imgDur;
    
    if (mpvLaunched) {
        await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "image-display-duration", imgDur] }) });
    }

    appSettings.keyboard_space = document.getElementById('setting-kb-space').checked;
    appSettings.keyboard_left_right = document.getElementById('setting-kb-lr').checked;
    appSettings.keyboard_up_down = document.getElementById('setting-kb-ud').checked;
    
    await invoke('save_settings', { content: JSON.stringify(appSettings) });
    applySettingsToUI();
    closeSettings();
});

    // Close popup window when clicking outside window
    settingsOverlay.addEventListener('click', (e) => {
        if (e.target === settingsOverlay) {
            closeSettings();
        }
});

// --- SETTINGS LOGIC ---
async function loadAppSettings() {
    const jsonStr = await invoke('load_settings');
    try {
        const parsed = JSON.parse(jsonStr);
        appSettings = { ...appSettings, ...parsed };
    } catch(e) {
        console.error("Failed to parse settings", e);
    }
    applySettingsToUI();
    syncSettingsPopup();
}

function applySettingsToUI() {
    applyLanguage(appSettings.language || 'en');

    const viewerBtn = document.getElementById('toggle-viewer-btn');
    if (viewerBtn) {
        viewerBtn.style.display = appSettings.viewer ? 'flex' : 'none';
    }
    // STRETCH button visibility by default 
    const stretchBtn = document.getElementById('stretch-btn');
    if (stretchBtn) {
        stretchBtn.style.display = appSettings.stretch ? 'block' : 'none';
    }
    const logBtnUi = document.getElementById('log-btn');
    if (logBtnUi) {
        logBtnUi.style.display = appSettings.show_logs_button ? 'block' : 'none';
    }
    const vuPrevCanvas = document.getElementById('preview-vu-canvas');
    if (vuPrevCanvas) vuPrevCanvas.style.display = appSettings.vumeter_preview ? 'block' : 'none';
    const vuProgCanvas = document.getElementById('program-vu-canvas');
    if (vuProgCanvas) vuProgCanvas.style.display = appSettings.vumeter_program ? 'block' : 'none';

    // VOLUME MAX LIMIT by default 
    const volSlider = document.getElementById('volume-slider');
    const volPercent = document.getElementById('volume-percent');
    if (volSlider && volPercent) {
        if (appSettings.allow_max_200) {
            volSlider.max = 200;
            volPercent.max = 200;
            volSlider.style.width = '100%'; 
        } else {
            volSlider.max = 100;
            volPercent.max = 100;
            volSlider.style.width = '50%'; 
            if (parseFloat(volSlider.value) > 100) {
                volSlider.value = 100;
                volPercent.value = 100;
                lastMasterVolume = 100;
            }
        }
        
        // Volume 100% or else
        let startupVol = appSettings.use_custom_startup_vol ? appSettings.startup_volume : 100;
        if (!appSettings.allow_max_200 && startupVol > 100) startupVol = 100;
        
        volSlider.value = startupVol;
        volPercent.value = startupVol;
        lastMasterVolume = startupVol;
        
        if (mpvLaunched) {
            invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "volume", startupVol] }) });
        }
        updateMuteUI(startupVol === 0);
    }
    // --- PLAYLIST SHOW by default ---
    if (showModeToggle) {
        showModeToggle.checked = appSettings.default_show_max;
    }
    if (showMaxInput) {
        showMaxInput.value = appSettings.default_max_items;
        showMaxInput.disabled = !appSettings.default_show_max;
    }
    
    // Pagination settings
    showMode = appSettings.default_show_max ? 'max' : 'all';
    itemsPerPage = appSettings.default_max_items;
    currentPage = 1;

    renderPlaylist();

    // --- PLAYLIST LOOP by default ---
    const loopPlaylistToggle = document.getElementById('loop-playlist-toggle');
    if (loopPlaylistToggle) {
        loopPlaylistToggle.checked = appSettings.default_loop_playlist;
    }
}

// --- KEYBOARD SHORTCUTS (Space, Arrows) ---
document.addEventListener('keydown', async (e) => {
    const tag = document.activeElement.tagName.toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;

    // 2. Space keyboard shortcut
    if (appSettings.keyboard_space && e.code === 'Space') {
        e.preventDefault(); 
        if (mpvLaunched) {
            await invoke('mpv_command', { command: JSON.stringify({ command: ["cycle", "pause"] }) });
        }
    }

    // 3. Left/right arrows keyboard shortcut
    if (appSettings.keyboard_left_right && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault();
        if (mpvLaunched) {
            const seekVal = e.key === 'ArrowLeft' ? -10 : 10;
            await invoke('mpv_command', { command: JSON.stringify({ command: ["seek", seekVal, "relative+exact"] }) });
        }
    }

    // 4. Up / Down arrows keyboard shortcut (Volume +/- 1)
    if (appSettings.keyboard_up_down && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        
        const volInput = document.getElementById('volume-percent');
        let currentVal = parseInt(volInput.value) || 0;
        let newVal = e.key === 'ArrowUp' ? currentVal + 1 : currentVal - 1;
        let maxAllowed = appSettings.allow_max_200 ? 200 : 100;
        newVal = Math.max(0, Math.min(maxAllowed, newVal));

        volInput.value = newVal;
        volInput.dispatchEvent(new Event('input'));
    }
});

function syncSettingsPopup() {
    const langSelect = document.getElementById('setting-language');
    if (langSelect) langSelect.value = appSettings.language;
    
    const viewerToggle = document.getElementById('setting-viewer');
    if (viewerToggle) viewerToggle.checked = appSettings.viewer;

    const stretchToggle = document.getElementById('setting-stretch');
    if (stretchToggle) stretchToggle.checked = appSettings.stretch;

    const logsBtnToggle = document.getElementById('setting-logs-btn');
    if (logsBtnToggle) logsBtnToggle.checked = appSettings.show_logs_button;

    const vuPrevToggle = document.getElementById('setting-vumeter-preview');
    if (vuPrevToggle) vuPrevToggle.checked = appSettings.vumeter_preview;
    const vuProgToggle = document.getElementById('setting-vumeter-program');
    if (vuProgToggle) vuProgToggle.checked = appSettings.vumeter_program;

    const screenRadio = document.querySelector(`input[name="viewer-screen"][value="${appSettings.viewer_screen}"]`);
    if (screenRadio) screenRadio.checked = true;
    
    const modeRadio = document.querySelector(`input[name="viewer-mode"][value="${appSettings.viewer_mode}"]`);
    if (modeRadio) modeRadio.checked = true;

    const maxVolToggle = document.getElementById('setting-max-vol');
    if (maxVolToggle) maxVolToggle.checked = appSettings.allow_max_200;

    const startupVolToggle = document.getElementById('setting-default-vol-toggle');
    const startupVolInput = document.getElementById('setting-default-vol-input');
    if (startupVolToggle) {
        startupVolToggle.checked = appSettings.use_custom_startup_vol;
    }
    if (startupVolInput) {
        let val = appSettings.startup_volume;
        if (!appSettings.allow_max_200 && val > 100) val = 100;
        startupVolInput.value = val;
        startupVolInput.max = appSettings.allow_max_200 ? 200 : 100;
        startupVolInput.disabled = !appSettings.use_custom_startup_vol; // Activ only if toggle is ON
    }

    const defShowToggle = document.getElementById('setting-default-show');
    if (defShowToggle) defShowToggle.checked = appSettings.default_show_max;

    const defMaxInput = document.getElementById('setting-default-max');
    if (defMaxInput) defMaxInput.value = appSettings.default_max_items;

    const defLoopToggle = document.getElementById('setting-default-loop');
    if (defLoopToggle) defLoopToggle.checked = appSettings.default_loop_playlist;

    const imgDurInput = document.getElementById('setting-image-duration');
    if (imgDurInput) imgDurInput.value = appSettings.image_display_duration;

    const kbSpace = document.getElementById('setting-kb-space');
    if (kbSpace) kbSpace.checked = appSettings.keyboard_space;

    const kbLr = document.getElementById('setting-kb-lr');
    if (kbLr) kbLr.checked = appSettings.keyboard_left_right;

    const kbUd = document.getElementById('setting-kb-ud');
    if (kbUd) kbUd.checked = appSettings.keyboard_up_down;
}

// Viewer screen & mode
document.getElementById('setting-default-vol-toggle').addEventListener('change', (e) => {
    // Active ou désactive l'input visuellement selon le toggle
    document.getElementById('setting-default-vol-input').disabled = !e.target.checked;
});

// Load SETTINGS at launch
async function initApp() {
    await loadAppSettings();
        // Wait for Tauri to be ready and check for secondary screen
        setTimeout(async () => {
            await autoStartViewer();
        }, 500);
}

async function autoStartViewer() {
    if (!mpvLaunched) {
        // On lance le processus MPV (il démarre en mode caché)
        const status = await invoke('toggle_viewer_window', { 
            programPath: programPath || "", 
            startTime: lastMpvTime, 
            isPaused: mpvPaused 
        });
        
        if (status === 2) {
            mpvLaunched = true;
            viewerVisible = false;
            isFullscreen = appSettings.viewer_mode === "fullscreen";
            updateFullscreenUI(isFullscreen); 
            
            // Wait 50ms for IPC pipe then display video
            setTimeout(async () => {
                await invoke('mpv_command', { command: JSON.stringify({ command: ["set_property", "vo", "gpu"] }) });
                viewerVisible = true;
                toggleViewerBtn.classList.toggle('btn-blue', viewerVisible);
                toggleViewerBtn.classList.toggle('btn-gray', !viewerVisible);
            }, 50);
        }
    }
}

// --- LOGS WINDOW ---
const logBtn = document.getElementById('log-btn');
if (logBtn) {
    logBtn.addEventListener('click', () => {
        invoke('toggle_logs');
    });
}

const originalLog = console.log;
const originalError = console.error;

function formatArgs(args) {
    return args.map(arg => {
        if (typeof arg === 'object') {
            try { return JSON.stringify(arg); } 
            catch (e) { return String(arg); }
        }
        return String(arg);
    }).join(' ');
}

console.log = function(...args) {
    const msg = formatArgs(args);
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke('write_log', { message: msg }).catch(() => {});
    }
    originalLog.apply(console, args);
};

console.error = function(...args) {
    const msg = 'ERROR: ' + formatArgs(args);
    if (window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke) {
        window.__TAURI__.core.invoke('write_log', { message: msg }).catch(() => {});
    }
    originalError.apply(console, args);
};

// Log test at launch
console.log("VPC Application started successfully.");

// LAUNCH APP
initApp();

document.getElementById('add-source-btn').addEventListener('click', loadSources);