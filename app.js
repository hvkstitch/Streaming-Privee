/* =====================================================================
   MaCinémathèque — app.js
   v2: Stockage persistant via IndexedDB (fichiers survivent au refresh)
   ===================================================================== */

// =====================================================================
// IndexedDB Setup
// =====================================================================

const DB_NAME    = 'macinema_db';
const DB_VERSION = 1;
const STORE_META = 'movies_meta';
const STORE_BLOB = 'movies_blobs';

let db = null;

function openDB() {
  return new Promise((resolve, reject) => {
    if (db) return resolve(db);
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_META))
        d.createObjectStore(STORE_META, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(STORE_BLOB))
        d.createObjectStore(STORE_BLOB, { keyPath: 'id' });
    };

    req.onsuccess = e => { db = e.target.result; resolve(db); };
    req.onerror   = e => reject(e.target.error);
  });
}

function dbPut(storeName, value) {
  return openDB().then(d => new Promise((resolve, reject) => {
    const tx  = d.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).put(value);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  }));
}

function dbGet(storeName, key) {
  return openDB().then(d => new Promise((resolve, reject) => {
    const tx  = d.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

function dbGetAll(storeName) {
  return openDB().then(d => new Promise((resolve, reject) => {
    const tx  = d.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  }));
}

function dbDelete(storeName, key) {
  return openDB().then(d => new Promise((resolve, reject) => {
    const tx  = d.transaction(storeName, 'readwrite');
    const req = tx.objectStore(storeName).delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  }));
}

// =====================================================================
// State
// =====================================================================

/** @type {Array<{id:string, name:string, title:string, size:number, ext:string, added:string}>} */
let movies = [];

/** In-memory map of movie id → blob URL (rebuilt from IndexedDB on load) */
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

(async function init() {
  showLoadingState();
  try {
    await restoreMovies();
  } catch (e) {
    console.warn('IndexedDB unavailable, falling back to localStorage', e);
    movies = JSON.parse(localStorage.getItem('macinema_index') || '[]');
  }
  renderGrid();
  updateStats();
  setupDropzone();
  hideLoadingState();
})();

function showLoadingState() {
  const empty = document.getElementById('emptyState');
  if (empty) empty.innerHTML = `
    <div class="big-icon" style="animation: pulse 1.5s infinite">🎬</div>
    <h3>Chargement de votre collection...</h3>
    <p>Restauration des films depuis le stockage local</p>`;
}

function hideLoadingState() {
  // renderGrid() will replace the content
}

// =====================================================================
// Tab Switching
// =====================================================================

function switchTab(name, clickedTab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  clickedTab.classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
}

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

function isVideoExtension(name) {
  return /\.(mp4|mkv|avi|mov|wmv|flv|webm|m4v|ts|m2ts|mpg|mpeg)$/i.test(name);
}

async function addMovie(file) {
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

  // Show optimistic UI immediately
  fileStore[id] = URL.createObjectURL(file);
  movies.push(movie);
  renderGrid();
  updateStats();
  showToast('⏳ Sauvegarde de ' + movie.title + '...', 'info');

  try {
    // Save metadata to IndexedDB
    await dbPut(STORE_META, movie);

    // Save the actual file blob to IndexedDB (persists across refreshes!)
    await dbPut(STORE_BLOB, { id, blob: file });

    showToast('✓ ' + movie.title + ' sauvegardé dans votre collection', 'success');
  } catch (e) {
    // Fallback: at least save metadata to localStorage
    localStorage.setItem('macinema_index', JSON.stringify(movies));
    showToast('⚠ Film ajouté (stockage limité — utilisez Chrome pour la persistance complète)', 'error');
    console.warn('IndexedDB save failed:', e);
  }
}

function cleanTitle(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Persist metadata fallback to localStorage */
function saveIndex() {
  localStorage.setItem('macinema_index', JSON.stringify(movies));
}

/**
 * On page load, restore movies AND their blobs from IndexedDB.
 * This is the key fix: blobs survive page refresh!
 */
async function restoreMovies() {
  // Load metadata
  const savedMeta = await dbGetAll(STORE_META);
  movies = savedMeta || [];

  if (movies.length === 0) {
    // Migration: check old localStorage data
    const legacy = JSON.parse(localStorage.getItem('macinema_index') || '[]');
    if (legacy.length > 0) {
      movies = legacy;
      // Migrate metadata to IndexedDB
      for (const m of movies) {
        await dbPut(STORE_META, m);
      }
      showToast('📦 Collection migrée vers le nouveau stockage persistant', 'info');
    }
  }

  // Restore blob URLs from IndexedDB
  let restoredCount = 0;
  for (const movie of movies) {
    try {
      const record = await dbGet(STORE_BLOB, movie.id);
      if (record && record.blob) {
        fileStore[movie.id] = URL.createObjectURL(record.blob);
        restoredCount++;
      }
    } catch (e) {
      console.warn('Could not restore blob for', movie.id, e);
    }
  }

  if (movies.length > 0 && restoredCount > 0) {
    showToast(`✓ ${restoredCount} film(s) restauré(s) depuis le stockage local`, 'success');
  }
}

// =====================================================================
// Utilities
// =====================================================================

function formatSize(bytes) {
  if (bytes < 1024 * 1024)           return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024)   return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function updateStats() {
  document.getElementById('stat-count').textContent = movies.length;
  const totalBytes = movies.reduce((sum, m) => sum + (m.size || 0), 0);
  document.getElementById('stat-size').textContent = formatSize(totalBytes);
}

// =====================================================================
// Render Grid
// =====================================================================

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
    empty.innerHTML = `
      <div class="big-icon">🎞</div>
      <h3>Votre collection est vide</h3>
      <p>
        Ajoutez vos films via l'onglet <strong class="accent">Ajouter</strong><br>
        Les fichiers sont sauvegardés localement et persistent entre les sessions.
      </p>`;
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

function buildMovieCard(m) {
  const available  = !!fileStore[m.id];
  const previewSrc = available ? `src="${fileStore[m.id]}"` : '';
  const thumbIcon  = available ? '🎬' : '📁';
  const thumbOpacity = available ? '0' : '0.3';
  const offlineBadge = !available
    ? `<div class="offline-badge" title="Fichier non disponible — ré-importez le film">⚠ Hors ligne</div>`
    : '';

  return `
    <div class="movie-card" data-id="${m.id}">
      <div class="movie-thumb">
        ${available ? `<video ${previewSrc} preload="metadata" muted style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0"></video>` : ''}
        <div style="position:relative;z-index:1;font-size:2.5rem;opacity:${thumbOpacity}">${thumbIcon}</div>
        <div class="play-overlay" onclick="openPlayer('${m.id}')">▶</div>
        <div class="movie-format">${m.ext}</div>
        ${offlineBadge}
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

function filterMovies(value) {
  renderGrid(value);
}

// =====================================================================
// Player
// =====================================================================

function openPlayer(id) {
  const movie = movies.find(m => m.id === id);
  if (!movie) return;

  const url = fileStore[id];
  if (!url) {
    showToast('Fichier non disponible. Ré-importez le film pour le lire.', 'error');
    return;
  }

  currentMovie = { ...movie, url };

  document.getElementById('modalTitle').textContent  = movie.title;
  document.getElementById('meta-name').textContent   = movie.name;
  document.getElementById('meta-size').textContent   = formatSize(movie.size);
  document.getElementById('meta-format').textContent = movie.ext;

  const player = document.getElementById('mainPlayer');
  player.src = url;
  player.play();

  resetConvertUI();

  document.getElementById('playerModal').classList.add('open');
}

function closeModal() {
  const player = document.getElementById('mainPlayer');
  player.pause();
  player.src = '';
  document.getElementById('playerModal').classList.remove('open');
  currentMovie = null;
}

document.getElementById('playerModal').addEventListener('click', function (e) {
  if (e.target === this) closeModal();
});

// =====================================================================
// Download
// =====================================================================

function downloadCurrentMovie() {
  if (!currentMovie) return;
  triggerDownload(currentMovie.url, currentMovie.name);
  showToast('⬇ Téléchargement de ' + currentMovie.name, 'info');
}

function downloadById(id) {
  const m   = movies.find(x => x.id === id);
  const url = fileStore[id];
  if (!m || !url) return;
  triggerDownload(url, m.name);
  showToast('⬇ Téléchargement de ' + m.name, 'info');
}

function triggerDownload(url, filename) {
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
}

// =====================================================================
// Delete
// =====================================================================

async function deleteMovie(id) {
  const m = movies.find(x => x.id === id);
  if (!m) return;
  if (!confirm(`Supprimer "${m.title}" de votre collection ?`)) return;

  if (fileStore[id]) {
    URL.revokeObjectURL(fileStore[id]);
    delete fileStore[id];
  }

  movies = movies.filter(x => x.id !== id);

  // Delete from IndexedDB
  try {
    await dbDelete(STORE_META, id);
    await dbDelete(STORE_BLOB, id);
  } catch (e) {
    console.warn('IndexedDB delete failed:', e);
    saveIndex(); // fallback
  }

  renderGrid();
  updateStats();
  showToast('Film supprimé de la collection', 'info');
}

// =====================================================================
// Convert to MP4
// =====================================================================

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

function stopStatsTimer() {
  if (convertStats.timerInterval) {
    clearInterval(convertStats.timerInterval);
    convertStats.timerInterval = null;
  }
}

function resetStatsDisplay() {
  document.getElementById('stat-elapsed').textContent   = '0:00';
  document.getElementById('stat-remaining').textContent = '—';
  document.getElementById('stat-speed').textContent     = '— MB/s';
  document.getElementById('stat-fps').textContent       = '— fps';
  document.getElementById('stat-written').textContent   = '0 MB';
  document.querySelectorAll('.stat-box').forEach(b => b.classList.remove('active'));
}

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
    const elapsed  = (now - convertStats.startTime) / 1000;
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

function tickFrame(now) {
  convertStats.frameCount++;
  const elapsed = (now - convertStats.startTime) / 1000;
  if (elapsed > 0) {
    const fps = Math.round(convertStats.frameCount / elapsed);
    document.getElementById('stat-fps').textContent = fps + ' fps';
  }
}

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

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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

async function runConversion() {
  const btn = document.getElementById('convertBtn');

  const video = document.createElement('video');
  video.src   = currentMovie.url;

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror          = reject;
  });

  const duration = video.duration;

  const candidates = [
    'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  const mimeType = candidates.find(m => MediaRecorder.isTypeSupported(m));
  if (!mimeType) throw new Error('Votre navigateur ne supporte pas l\'enregistrement vidéo');

  const canvas  = document.createElement('canvas');
  const ctx     = canvas.getContext('2d');
  canvas.width  = video.videoWidth  || 1280;
  canvas.height = video.videoHeight || 720;

  const audioCtx = new AudioContext();
  const src      = audioCtx.createMediaElementSource(video);
  const dest     = audioCtx.createMediaStreamDestination();
  src.connect(dest);
  src.connect(audioCtx.destination);

  const videoStream = canvas.captureStream(30);
  const combined    = new MediaStream([...videoStream.getTracks(), ...dest.stream.getTracks()]);

  const quality  = document.getElementById('qualitySelect').value;
  const bitrates = { high: 8_000_000, medium: 4_000_000, low: 1_500_000 };
  const bitrate  = bitrates[quality] || bitrates.medium;

  const recorder = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: bitrate });
  const chunks   = [];

  recorder.ondataavailable = e => {
    if (e.data.size) {
      chunks.push(e.data);
      tickBytes(e.data.size);
    }
  };
  recorder.start(500);

  startStatsTimer(duration);

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

  await Promise.race([
    new Promise(res => { video.onended = res; }),
    new Promise(res => setTimeout(res, (duration + 5) * 1000)),
  ]);

  recorder.stop();
  await new Promise(res => { recorder.onstop = res; });
  audioCtx.close();
  stopStatsTimer();

  const ext     = mimeType.includes('mp4') ? 'mp4' : 'webm';
  const blob    = new Blob(chunks, { type: mimeType });
  const blobUrl = URL.createObjectURL(blob);
  const outName = currentMovie.title + '_converti.' + ext;

  setProgress(100, 'Conversion terminée !');

  const totalElapsed = (performance.now() - convertStats.startTime) / 1000;
  document.getElementById('stat-elapsed').textContent   = formatDuration(totalElapsed);
  document.getElementById('stat-remaining').textContent = '0:00';
  document.getElementById('stat-written').textContent   = formatSize(blob.size);

  showConvertSuccess(blobUrl, outName, blob.size);
  showToast('✓ Conversion réussie !', 'success');
  btn.textContent = 'Reconvertir';
  btn.disabled    = false;
}

function updateConvertProgress(currentTime, duration) {
  const pct = Math.min(99, Math.round((currentTime / duration) * 100));
  setProgress(pct, `Conversion : ${currentTime.toFixed(0)}s / ${duration.toFixed(0)}s`);
}

function setProgress(pct, label) {
  document.getElementById('progressFill').style.width  = pct + '%';
  document.getElementById('progressPct').textContent   = pct + '%';
  document.getElementById('progressLabel').textContent = label;
}

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

async function addConverted(url, name, size) {
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

  // Fetch the blob from the URL to persist it
  try {
    const response = await fetch(url);
    const blob     = await response.blob();

    fileStore[id] = url;
    movies.push(movie);

    await dbPut(STORE_META, movie);
    await dbPut(STORE_BLOB, { id, blob });

    renderGrid();
    updateStats();
    showToast('✓ Film converti sauvegardé dans la collection', 'success');
  } catch (e) {
    // Fallback without persistence
    fileStore[id] = url;
    movies.push(movie);
    saveIndex();
    renderGrid();
    updateStats();
    showToast('✓ Film converti ajouté (non persistant)', 'info');
  }
}

// =====================================================================
// Toast Notifications
// =====================================================================

function showToast(message, type = 'info') {
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toastContainer');

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;

  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
