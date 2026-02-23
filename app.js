/* =====================================================================
   MaCinémathèque — app.js
   All movies are handled locally in the browser. No server needed.
   ===================================================================== */

// =====================================================================
// State
// =====================================================================

/** @type {Array<{id:string, name:string, title:string, size:number, ext:string, added:string}>} */
let movies = JSON.parse(localStorage.getItem('macinema_index') || '[]');

/** In-memory map of movie id → blob URL (lost on page refresh) */
const fileStore = {};

/** Currently open movie in the player */
let currentMovie = null;

/** Conversion stats tracker */
const convertStats = {
  startTime:     0,
  lastFrameTime: 0,
  frameCount:    0,
  bytesWritten:  0,
  lastByteTime:  0,
  lastBytes:     0,
  speedMBs:      0,
  timerInterval: null,
};

// =====================================================================
// Init
// =====================================================================

(function init() {
  restoreMovies();
  renderGrid();
  updateStats();
  setupDropzone();
})();

// =====================================================================
// Tab Switching
// =====================================================================

/**
 * Switch between the Library and Upload tabs.
 * @param {string} name - 'library' | 'upload'
 * @param {HTMLElement} clickedTab - the button that was clicked
 */
function switchTab(name, clickedTab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  clickedTab.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

/** Programmatically switch to a tab by name (used after adding files). */
function switchTabDirect(name) {
  const tabs = document.querySelectorAll('.tab');
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  tabs.forEach(t => t.classList.remove('active'));
  if (name === 'library') tabs[0].classList.add('active');
  if (name === 'upload')  tabs[1].classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

// =====================================================================
// Drag & Drop
// =====================================================================

function setupDropzone() {
  const dz = document.getElementById('dropzone');

  ['dragenter', 'dragover'].forEach(evt =>
    dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.add('drag'); })
  );

  ['dragleave', 'drop'].forEach(evt =>
    dz.addEventListener(evt, e => { e.preventDefault(); dz.classList.remove('drag'); })
  );

  dz.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
}

// =====================================================================
// File Handling
// =====================================================================

/**
 * Handle a FileList from input or drag-drop.
 * @param {FileList} files
 */
function handleFiles(files) {
  if (!files.length) return;
  let added = 0;
  Array.from(files).forEach(file => {
    if (!file.type.startsWith('video/') && !isVideoExtension(file.name)) {
      showToast('Fichier ignoré : ' + file.name + ' (format non vidéo)', 'error');
      return;
    }
    addMovie(file);
    added++;
  });
  if (added > 0) switchTabDirect('library');
}

/**
 * Check if a filename has a known video extension.
 * @param {string} name
 * @returns {boolean}
 */
function isVideoExtension(name) {
  return /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i.test(name);
}

/**
 * Add a file to the movie collection.
 * @param {File} file
 */
function addMovie(file) {
  const id  = 'mv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const ext = file.name.split('.').pop().toUpperCase();

  const movie = {
    id,
    name:  file.name,
    title: cleanTitle(file.name),
    size:  file.size,
    ext,
    added: new Date().toLocaleDateString('fr-FR'),
  };

  // Store a temporary Blob URL in memory
  fileStore[id] = URL.createObjectURL(file);

  movies.push(movie);
  saveIndex();
  renderGrid();
  updateStats();
  showToast('✓ ' + movie.title + ' ajouté à votre collection', 'success');
}

/**
 * Clean a filename into a readable title.
 * @param {string} filename
 * @returns {string}
 */
function cleanTitle(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Persist the movie index (metadata only, not blobs) to localStorage. */
function saveIndex() {
  localStorage.setItem('macinema_index', JSON.stringify(movies));
}

/**
 * On page load, blob URLs are gone. Mark movies without blobs as offline.
 */
function restoreMovies() {
  movies = movies.map(m => ({ ...m, offline: !fileStore[m.id] }));
}

// =====================================================================
// Utilities
// =====================================================================

/**
 * Format bytes into a human-readable string.
 * @param {number} bytes
 * @returns {string}
 */
function formatSize(bytes) {
  if (bytes < 1024 * 1024)           return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024)   return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

/** Update the header stats bar. */
function updateStats() {
  document.getElementById('stat-count').textContent = movies.length;
  const totalBytes = movies.reduce((sum, m) => sum + (m.size || 0), 0);
  document.getElementById('stat-size').textContent = formatSize(totalBytes);
}

// =====================================================================
// Render Grid
// =====================================================================

/**
 * Render the movie grid, optionally filtered by a search string.
 * @param {string} filter
 */
function renderGrid(filter = '') {
  const grid     = document.getElementById('movieGrid');
  const empty    = document.getElementById('emptyState');
  const label    = document.getElementById('film-count-label');

  const visible = filter
    ? movies.filter(m => m.title.toLowerCase().includes(filter.toLowerCase()))
    : movies;

  label.textContent = movies.length ? `(${movies.length})` : '';

  if (!movies.length) {
    grid.style.display  = 'none';
    empty.style.display = 'block';
    return;
  }

  grid.style.display  = 'grid';
  empty.style.display = 'none';

  grid.innerHTML = visible.map(buildMovieCard).join('');

  // Seek each preview video to a thumbnail frame
  visible.forEach(m => {
    if (fileStore[m.id]) {
      const vid = grid.querySelector(`[data-id="${m.id}"] video`);
      if (vid) vid.currentTime = 10;
    }
  });
}

/**
 * Build the HTML string for a single movie card.
 * @param {{id:string, title:string, name:string, size:number, ext:string, added:string}} m
 * @returns {string}
 */
function buildMovieCard(m) {
  const available = !!fileStore[m.id];
  const previewSrc = available ? `src="${fileStore[m.id]}"` : '';
  const thumbIcon  = available ? '🎬' : '📁';
  const thumbOpacity = available ? '0' : '0.3';

  return `
    <div class="movie-card" data-id="${m.id}">
      <div class="movie-thumb">
        ${available ? `<video ${previewSrc} preload="metadata" muted style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0"></video>` : ''}
        <div style="position:relative;z-index:1;font-size:2.5rem;opacity:${thumbOpacity}">${thumbIcon}</div>
        <div class="play-overlay" onclick="openPlayer('${m.id}')">▶</div>
        <div class="movie-format">${m.ext}</div>
      </div>
      <div class="movie-info">
        <h3 title="${m.title}">${m.title}</h3>
        <div class="meta">
          <span>${formatSize(m.size)}</span>
          <span>${m.added}</span>
        </div>
      </div>
      <div class="movie-actions">
        <button class="btn btn-primary"    onclick="openPlayer('${m.id}')"           ${!available ? 'disabled' : ''}>▶ Lire</button>
        <button class="btn btn-secondary"  onclick="downloadById('${m.id}')"          ${!available ? 'disabled' : ''}>⬇</button>
        <button class="btn btn-danger"     onclick="deleteMovie('${m.id}')">🗑</button>
      </div>
    </div>`;
}

/** Filter the grid from the search input. */
function filterMovies(value) {
  renderGrid(value);
}

// =====================================================================
// Player
// =====================================================================

/**
 * Open the video player modal for a given movie id.
 * @param {string} id
 */
function openPlayer(id) {
  const movie = movies.find(m => m.id === id);
  if (!movie) return;

  const url = fileStore[id];
  if (!url) {
    showToast('Fichier non disponible. Ré-importez le film pour le lire.', 'error');
    return;
  }

  currentMovie = { ...movie, url };

  // Fill modal info
  document.getElementById('modalTitle').textContent  = movie.title;
  document.getElementById('meta-name').textContent   = movie.name;
  document.getElementById('meta-size').textContent   = formatSize(movie.size);
  document.getElementById('meta-format').textContent = movie.ext;

  // Load & play
  const player = document.getElementById('mainPlayer');
  player.src = url;
  player.play();

  // Reset convert UI
  resetConvertUI();

  document.getElementById('playerModal').classList.add('open');
}

/** Close the player modal and stop playback. */
function closeModal() {
  const player = document.getElementById('mainPlayer');
  player.pause();
  player.src = '';
  document.getElementById('playerModal').classList.remove('open');
  currentMovie = null;
}

// Close modal when clicking the backdrop
document.getElementById('playerModal').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});

// =====================================================================
// Download
// =====================================================================

/** Download the currently open movie. */
function downloadCurrentMovie() {
  if (!currentMovie) return;
  triggerDownload(currentMovie.url, currentMovie.name);
  showToast('⬇ Téléchargement de ' + currentMovie.name, 'info');
}

/**
 * Download a movie from the grid by id.
 * @param {string} id
 */
function downloadById(id) {
  const m   = movies.find(x => x.id === id);
  const url = fileStore[id];
  if (!m || !url) return;
  triggerDownload(url, m.name);
  showToast('⬇ Téléchargement de ' + m.name, 'info');
}

/**
 * Trigger a browser download.
 * @param {string} url
 * @param {string} filename
 */
function triggerDownload(url, filename) {
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
}

// =====================================================================
// Delete
// =====================================================================

/**
 * Delete a movie from the collection.
 * @param {string} id
 */
function deleteMovie(id) {
  const m = movies.find(x => x.id === id);
  if (!m) return;
  if (!confirm(`Supprimer "${m.title}" de votre collection ?`)) return;

  if (fileStore[id]) {
    URL.revokeObjectURL(fileStore[id]);
    delete fileStore[id];
  }

  movies = movies.filter(x => x.id !== id);
  saveIndex();
  renderGrid();
  updateStats();
  showToast('Film supprimé de la collection', 'info');
}

// =====================================================================
// Convert to MP4
// =====================================================================

/** Reset the conversion UI to its initial state. */
function resetConvertUI() {
  document.getElementById('convertProgress').style.display = 'none';
  document.getElementById('convertResult').style.display   = 'none';
  document.getElementById('progressFill').style.width      = '0%';
  document.getElementById('progressPct').textContent       = '0%';
  document.getElementById('progressLabel').textContent     = 'Traitement...';

  const btn       = document.getElementById('convertBtn');
  btn.disabled    = false;
  btn.textContent = 'Convertir en MP4';

  stopStatsTimer();
  resetStatsDisplay();
}

/** Stop the live stats update interval. */
function stopStatsTimer() {
  if (convertStats.timerInterval) {
    clearInterval(convertStats.timerInterval);
    convertStats.timerInterval = null;
  }
}

/** Reset all stats to zero. */
function resetStatsDisplay() {
  document.getElementById('stat-elapsed').textContent   = '0:00';
  document.getElementById('stat-remaining').textContent = '—';
  document.getElementById('stat-speed').textContent     = '— MB/s';
  document.getElementById('stat-fps').textContent       = '— fps';
  document.getElementById('stat-written').textContent   = '0 MB';
  document.querySelectorAll('.stat-box').forEach(b => b.classList.remove('active'));
}

/** Start tracking and updating live stats. */
function startStatsTimer(getDuration, getBytesTotal) {
  convertStats.startTime     = performance.now();
  convertStats.lastByteTime  = performance.now();
  convertStats.lastBytes     = 0;
  convertStats.bytesWritten  = 0;
  convertStats.frameCount    = 0;
  convertStats.speedMBs      = 0;

  document.querySelectorAll('.stat-box').forEach(b => b.classList.add('active'));

  convertStats.timerInterval = setInterval(() => {
    const now      = performance.now();
    const elapsed  = (now - convertStats.startTime) / 1000; // seconds
    const pct      = parseFloat(document.getElementById('progressFill').style.width) / 100;
    const remaining = pct > 0.01 ? (elapsed / pct) * (1 - pct) : null;

    document.getElementById('stat-elapsed').textContent =
      formatDuration(elapsed);

    document.getElementById('stat-remaining').textContent =
      remaining !== null ? formatDuration(remaining) : '—';

    document.getElementById('stat-written').textContent =
      formatSize(convertStats.bytesWritten);

  }, 500);
}

/**
 * Update frame rate stat — call this from the draw loop.
 * @param {number} now - performance.now() timestamp
 */
function tickFrame(now) {
  convertStats.frameCount++;
  const elapsed = (now - convertStats.startTime) / 1000;
  if (elapsed > 0) {
    const fps = Math.round(convertStats.frameCount / elapsed);
    document.getElementById('stat-fps').textContent = fps + ' fps';
  }
}

/**
 * Update bytes-written stat (called each time MediaRecorder fires ondataavailable).
 * @param {number} bytes
 */
function tickBytes(bytes) {
  const now = performance.now();
  convertStats.bytesWritten += bytes;

  const dt = (now - convertStats.lastByteTime) / 1000;
  if (dt >= 0.5) {
    const delta = convertStats.bytesWritten - convertStats.lastBytes;
    convertStats.speedMBs  = delta / dt / (1024 * 1024);
    convertStats.lastBytes  = convertStats.bytesWritten;
    convertStats.lastByteTime = now;

    document.getElementById('stat-speed').textContent =
      convertStats.speedMBs.toFixed(2) + ' MB/s';
  }
}

/**
 * Format seconds into M:SS string.
 * @param {number} seconds
 * @returns {string}
 */
function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Convert the currently open movie to MP4 using MediaRecorder. */
async function convertCurrentMovie() {
  if (!currentMovie) return;

  const btn       = document.getElementById('convertBtn');
  btn.disabled    = true;
  btn.textContent = 'Conversion...';

  document.getElementById('convertProgress').style.display = 'block';
  document.getElementById('convertResult').style.display   = 'none';

  showToast('⚙ Début de la conversion en MP4...', 'info');

  try {
    await runConversion();
  } catch (err) {
    handleConversionError(err);
  }
}

/** Core conversion logic using canvas + MediaRecorder. */
async function runConversion() {
  const btn = document.getElementById('convertBtn');

  // Create an off-screen video element
  const video = document.createElement('video');
  video.src   = currentMovie.url;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror          = reject;
  });

  const duration = video.duration;

  // Find a supported MIME type (prefer MP4, fall back to WebM)
  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mimeType = candidates.find(m => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error('Votre navigateur ne supporte pas l\'enregistrement vidéo');

  // Canvas for video frames
  const canvas  = document.createElement('canvas');
  const ctx     = canvas.getContext('2d');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;

  // Audio routing
  const audioCtx = new AudioContext();
  const src      = audioCtx.createMediaElementSource(video);
  const dest     = audioCtx.createMediaStreamDestination();
  src.connect(dest);
  src.connect(audioCtx.destination);

  // Combine video & audio streams
  const videoStream = canvas.captureStream(30);
  const combined    = new MediaStream([...videoStream.getTracks(), ...dest.stream.getTracks()]);

  // Bitrate based on quality selection
  const quality  = document.getElementById('qualitySelect').value;
  const bitrates = { high: 8_000_000, medium: 4_000_000, low: 1_500_000 };
  const bitrate  = bitrates[quality] || bitrates.medium;

  const recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: bitrate });
  const chunks   = [];

  // ---- Wire stats ----
  recorder.ondataavailable = e => {
    if (e.data.size) {
      chunks.push(e.data);
      tickBytes(e.data.size);
    }
  };
  recorder.start(500); // fire every 500ms for smoother speed readings

  // Start the stats overlay
  startStatsTimer(duration);

  // Play and draw frames to canvas
  video.currentTime = 0;
  video.play();

  const drawLoop = () => {
    if (video.paused || video.ended) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    updateConvertProgress(video.currentTime, duration);
    tickFrame(performance.now());
    requestAnimationFrame(drawLoop);
  };

  video.onplay = drawLoop;

  // Wait for the video to finish (with a safety timeout)
  await Promise.race([
    new Promise(res => { video.onended = res; }),
    new Promise(res => setTimeout(res, (duration + 5) * 1000)),
  ]);

  recorder.stop();
  await new Promise(res => { recorder.onstop = res; });
  audioCtx.close();
  stopStatsTimer();

  // Build result blob
  const ext     = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const blob    = new Blob(chunks, { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const outName = currentMovie.title + '_converti.' + ext;

  setProgress(100, 'Conversion terminée !');

  // Final stats snapshot
  const totalElapsed = (performance.now() - convertStats.startTime) / 1000;
  document.getElementById('stat-elapsed').textContent   = formatDuration(totalElapsed);
  document.getElementById('stat-remaining').textContent = '0:00';
  document.getElementById('stat-written').textContent   = formatSize(blob.size);

  showConvertSuccess(blobUrl, outName, blob.size);
  showToast('✓ Conversion réussie !', 'success');
  btn.textContent = 'Reconvertir';
  btn.disabled    = false;
}

/**
 * Update the progress bar during conversion.
 * @param {number} currentTime
 * @param {number} duration
 */
function updateConvertProgress(currentTime, duration) {
  const pct = Math.min(99, Math.round((currentTime / duration) * 100));
  setProgress(pct, `Conversion : ${currentTime.toFixed(0)}s / ${duration.toFixed(0)}s`);
}

/**
 * Set the progress bar value and label.
 * @param {number} pct - 0 to 100
 * @param {string} label
 */
function setProgress(pct, label) {
  document.getElementById('progressFill').style.width  = pct + '%';
  document.getElementById('progressPct').textContent   = pct + '%';
  document.getElementById('progressLabel').textContent = label;
}

/**
 * Show the success message after conversion.
 * @param {string} url
 * @param {string} name
 * @param {number} size
 */
function showConvertSuccess(url, name, size) {
  const div  = document.getElementById('convertResult');
  div.style.display = 'block';
  div.innerHTML = `
    <div class="result-success">
      <span class="result-icon">✓</span>
      <span class="result-text">Conversion terminée — <strong>${name}</strong> (${formatSize(size)})</span>
      <button class="btn btn-primary"   onclick="triggerDownload('${url}','${name}')">⬇ Télécharger</button>
      <button class="btn btn-secondary" onclick="addConverted('${url}','${name}',${size})">+ Ajouter à la collection</button>
    </div>`;
}

/**
 * Handle a conversion failure.
 * @param {Error} err
 */
function handleConversionError(err) {
  stopStatsTimer();
  showToast('Erreur de conversion : ' + err.message, 'error');
  console.error('[Conversion Error]', err);

  const btn      = document.getElementById('convertBtn');
  btn.textContent = 'Convertir en MP4';
  btn.disabled    = false;

  const div = document.getElementById('convertResult');
  div.style.display = 'block';
  div.innerHTML = `
    <div class="result-warning">
      ⚠ Conversion automatique non supportée par votre navigateur.<br>
      <strong style="color:var(--accent)">Solution :</strong>
      Téléchargez le fichier original et utilisez
      <a href="https://www.handbrake.fr" target="_blank">HandBrake</a>
      (gratuit) pour convertir en MP4.
      <br><br>
      <button class="btn btn-secondary" onclick="downloadCurrentMovie()" style="width:auto">⬇ Télécharger l'original</button>
    </div>`;
}

/**
 * Add a converted file to the collection.
 * @param {string} url - Blob URL
 * @param {string} name
 * @param {number} size
 */
function addConverted(url, name, size) {
  const id  = 'mv_conv_' + Date.now();
  const ext = name.split('.').pop().toUpperCase();

  const movie = {
    id,
    name,
    size,
    title: cleanTitle(name),
    ext,
    added: new Date().toLocaleDateString('fr-FR'),
  };

  fileStore[id] = url;
  movies.push(movie);
  saveIndex();
  renderGrid();
  updateStats();
  showToast('✓ Film converti ajouté à la collection', 'success');
}

// =====================================================================
// Toast Notifications
// =====================================================================

/**
 * Display a toast notification.
 * @param {string} message
 * @param {'info'|'success'|'error'} type
 */
function showToast(message, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toastContainer');

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;

  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
