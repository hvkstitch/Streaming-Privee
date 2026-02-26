/* =====================================================================
   MaCinémathèque — app.js
   v3: Supabase sync (métadonnées en DB + fichiers vidéo dans Storage)
       Collection partagée entre tous les appareils, sans compte.
   ===================================================================== */

// =====================================================================
// Supabase Config
// =====================================================================

const SUPABASE_URL  = 'https://olhfduqnxhaoaxcxjxxi.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9saGZkdXFueGhhb2F4Y3hqeHhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMDI3NTgsImV4cCI6MjA4NzY3ODc1OH0.gJokdFbBt5k9DuHBkMRtxhHcNQNJlyOjXnXMNu-Q-1k';
const BUCKET = 'movies';
const TABLE  = 'movies';

const supa = {
  headers: {
    'apikey':        SUPABASE_ANON,
    'Authorization': 'Bearer ' + SUPABASE_ANON,
    'Content-Type':  'application/json',
  },

  async select(table, query = '') {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: this.headers });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async insert(table, row) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
      method:  'POST',
      headers: { ...this.headers, 'Prefer': 'return=representation' },
      body:    JSON.stringify(row),
    });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  async delete(table, filter) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
      method:  'DELETE',
      headers: this.headers,
    });
    if (!res.ok) throw new Error(await res.text());
  },

  async deleteFile(path) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
      method:  'DELETE',
      headers: { ...this.headers },
      body:    JSON.stringify({ prefixes: [path] }),
    });
    if (!res.ok) throw new Error(await res.text());
  },

  fileUrl(path) {
    return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${path}`;
  },
};

// =====================================================================
// IndexedDB — cache local (lecture rapide sans re-téléchargement)
// =====================================================================

const DB_NAME    = 'macinema_db';
const DB_VERSION = 1;
const STORE_BLOB = 'movies_blobs';
let   idb        = null;

function openIDB() {
  return new Promise((resolve, reject) => {
    if (idb) return resolve(idb);
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE_BLOB))
        d.createObjectStore(STORE_BLOB, { keyPath: 'id' });
    };
    req.onsuccess = e => { idb = e.target.result; resolve(idb); };
    req.onerror   = e => reject(e.target.error);
  });
}

async function idbPut(value) {
  const d = await openIDB();
  return new Promise((res, rej) => {
    const tx  = d.transaction(STORE_BLOB, 'readwrite');
    const req = tx.objectStore(STORE_BLOB).put(value);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbGet(id) {
  const d = await openIDB();
  return new Promise((res, rej) => {
    const tx  = d.transaction(STORE_BLOB, 'readonly');
    const req = tx.objectStore(STORE_BLOB).get(id);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbDelete(id) {
  const d = await openIDB();
  return new Promise((res, rej) => {
    const tx  = d.transaction(STORE_BLOB, 'readwrite');
    const req = tx.objectStore(STORE_BLOB).delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// =====================================================================
// State
// =====================================================================

let movies       = [];
const fileStore  = {};   // id → URL (blob local ou URL Supabase)
let currentMovie = null;

const convertStats = {
  startTime: 0, lastFrameTime: 0, frameCount: 0,
  bytesWritten: 0, lastByteTime: 0, lastBytes: 0,
  speedMBs: 0, timerInterval: null,
};

// =====================================================================
// Init
// =====================================================================

(async function init() {
  showSyncBanner('Connexion à Supabase...');
  setupDropzone();

  try {
    await loadMoviesFromSupabase();
    hideSyncBanner();
    if (movies.length > 0) showToast(`✓ ${movies.length} film(s) synchronisé(s)`, 'success');
  } catch (e) {
    hideSyncBanner();
    showToast('⚠ Hors-ligne — Supabase inaccessible', 'error');
    console.warn('Supabase error:', e);
    movies = JSON.parse(localStorage.getItem('macinema_index') || '[]');
  }

  renderGrid();
  updateStats();
})();

// =====================================================================
// Supabase — Chargement
// =====================================================================

async function loadMoviesFromSupabase() {
  const rows = await supa.select(TABLE, 'order=added_at.desc');
  movies = rows.map(r => ({
    id:           r.id,
    name:         r.name,
    title:        r.title,
    size:         r.size,
    ext:          r.ext,
    added:        r.added,
    storage_path: r.storage_path,
  }));

  // Pour chaque film : cache local d'abord, sinon URL Supabase directe
  for (const m of movies) {
    try {
      const cached = await idbGet(m.id);
      if (cached && cached.blob) {
        fileStore[m.id] = URL.createObjectURL(cached.blob);
      } else if (m.storage_path) {
        fileStore[m.id] = supa.fileUrl(m.storage_path);
      }
    } catch {
      if (m.storage_path) fileStore[m.id] = supa.fileUrl(m.storage_path);
    }
  }
}

// =====================================================================
// Sync Banner
// =====================================================================

function showSyncBanner(msg) {
  let banner = document.getElementById('syncBanner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'syncBanner';
    banner.style.cssText = `
      position:fixed;top:0;left:0;right:0;z-index:9998;
      background:linear-gradient(90deg,#1e2535,#0f1219);
      border-bottom:1px solid #1e2535;
      padding:8px 48px;font-size:0.7rem;color:#6b7385;
      display:flex;align-items:center;gap:10px;
    `;
    banner.innerHTML = `<span style="display:inline-block;animation:spin 1s linear infinite">⟳</span><span id="syncMsg">${msg}</span>`;
    document.body.prepend(banner);
  } else {
    document.getElementById('syncMsg').textContent = msg;
  }
}

function hideSyncBanner() {
  const b = document.getElementById('syncBanner');
  if (b) { b.style.opacity = '0'; b.style.transition = 'opacity 0.5s'; setTimeout(() => b.remove(), 500); }
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
  const id   = 'mv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const ext  = file.name.split('.').pop().toUpperCase();
  const path = `${id}/${file.name}`;

  const movie = {
    id, path,
    name:         file.name,
    title:        cleanTitle(file.name),
    size:         file.size,
    ext,
    added:        new Date().toLocaleDateString('fr-FR'),
    storage_path: path,
    uploading:    true,
  };

  // UI optimiste
  fileStore[id] = URL.createObjectURL(file);
  movies.unshift(movie);
  renderGrid();
  updateStats();

  try {
    showToast('⬆ Upload de ' + movie.title + '...', 'info');
    const card = document.querySelector(`[data-id="${id}"]`);

    // Upload fichier → Supabase Storage
    await uploadWithProgress(file, path, card);

    // Sauvegarde métadonnées → Supabase DB
    await supa.insert(TABLE, {
      id,
      name:         movie.name,
      title:        movie.title,
      size:         movie.size,
      ext:          movie.ext,
      added:        movie.added,
      storage_path: path,
    });

    // Cache local IndexedDB
    await idbPut({ id, blob: file });

    movie.uploading = false;
    renderGrid();
    showToast('✓ ' + movie.title + ' synchronisé sur tous vos appareils !', 'success');

  } catch (e) {
    console.error('Upload error:', e);
    movie.uploading    = false;
    movie.storage_path = null;
    localStorage.setItem('macinema_index', JSON.stringify(movies));
    renderGrid();
    showToast('⚠ Upload échoué — sauvegardé localement seulement', 'error');
  }
}

function uploadWithProgress(file, path, card) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${SUPABASE_URL}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`);
    xhr.setRequestHeader('apikey', SUPABASE_ANON);
    xhr.setRequestHeader('Authorization', 'Bearer ' + SUPABASE_ANON);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('x-upsert', 'true');

    xhr.upload.onprogress = e => {
      if (e.lengthComputable && card) {
        const pct = Math.round((e.loaded / e.total) * 100);
        let bar = card.querySelector('.upload-progress-bar');
        if (!bar) {
          bar = document.createElement('div');
          bar.className = 'upload-progress-bar';
          bar.innerHTML = `<div class="upload-progress-fill"></div><span class="upload-progress-label">0%</span>`;
          card.querySelector('.movie-thumb').appendChild(bar);
        }
        bar.querySelector('.upload-progress-fill').style.width = pct + '%';
        bar.querySelector('.upload-progress-label').textContent = pct + '%';
      }
    };

    xhr.onload  = () => {
      if (xhr.status < 300) { resolve(); }
      else { reject(new Error(`Supabase Storage error ${xhr.status}: ${xhr.responseText}`)); }
    };
    xhr.onerror = () => reject(new Error('Erreur réseau'));
    xhr.send(file);
  });
}

function cleanTitle(filename) {
  return filename
    .replace(/\.[^.]+$/, '')
    .replace(/[._\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// =====================================================================
// Utilities
// =====================================================================

function formatSize(bytes) {
  if (bytes < 1024 * 1024)         return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
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
  const grid  = document.getElementById('movieGrid');
  const empty = document.getElementById('emptyState');
  const label = document.getElementById('film-count-label');

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
      <p>Ajoutez vos films via l'onglet <strong class="accent">Ajouter</strong><br>
      Ils seront synchronisés automatiquement sur tous vos appareils.</p>`;
    return;
  }

  grid.style.display  = 'grid';
  empty.style.display = 'none';
  grid.innerHTML = visible.map(buildMovieCard).join('');

  visible.forEach(m => {
    if (fileStore[m.id] && !m.uploading) {
      const vid = grid.querySelector(`[data-id="${m.id}"] video`);
      if (vid) vid.currentTime = 10;
    }
  });
}

function buildMovieCard(m) {
  const available = !!fileStore[m.id];
  const previewSrc = available && !m.uploading ? `src="${fileStore[m.id]}"` : '';
  const thumbOpacity = available && !m.uploading ? '0' : '0.3';

  const badge = m.uploading
    ? `<div class="sync-badge uploading" title="Upload en cours...">⬆ Upload...</div>`
    : m.storage_path
      ? `<div class="sync-badge" title="Synchronisé sur Supabase">☁ Sync</div>`
      : `<div class="offline-badge" title="Local uniquement">⚠ Local</div>`;

  return `
    <div class="movie-card" data-id="${m.id}">
      <div class="movie-thumb">
        ${available && !m.uploading
          ? `<video ${previewSrc} preload="metadata" muted crossorigin="anonymous"
               style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0"></video>`
          : ''}
        <div style="position:relative;z-index:1;font-size:2.5rem;opacity:${thumbOpacity}">🎬</div>
        <div class="play-overlay" onclick="openPlayer('${m.id}')">▶</div>
        <div class="movie-format">${m.ext}</div>
        ${badge}
      </div>
      <div class="movie-info">
        <h3 title="${m.title}">${m.title}</h3>
        <div class="meta">
          <span>${formatSize(m.size)}</span>
          <span>${m.added}</span>
        </div>
      </div>
      <div class="movie-actions">
        <button class="btn btn-primary"   onclick="openPlayer('${m.id}')"  ${!available || m.uploading ? 'disabled' : ''}>▶ Lire</button>
        <button class="btn btn-secondary" onclick="downloadById('${m.id}')" ${!available || m.uploading ? 'disabled' : ''}>⬇</button>
        <button class="btn btn-danger"    onclick="deleteMovie('${m.id}')"  ${m.uploading ? 'disabled' : ''}>🗑</button>
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
  if (!url) { showToast('Fichier non disponible.', 'error'); return; }

  currentMovie = { ...movie, url };
  document.getElementById('modalTitle').textContent  = movie.title;
  document.getElementById('meta-name').textContent   = movie.name;
  document.getElementById('meta-size').textContent   = formatSize(movie.size);
  document.getElementById('meta-format').textContent = movie.ext;

  const player = document.getElementById('mainPlayer');
  player.src = url;
  player.crossOrigin = 'anonymous';
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
}

function downloadById(id) {
  const m   = movies.find(x => x.id === id);
  const url = fileStore[id];
  if (!m || !url) return;
  triggerDownload(url, m.name);
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

  if (fileStore[id] && !fileStore[id].startsWith('http')) {
    URL.revokeObjectURL(fileStore[id]);
  }
  delete fileStore[id];
  movies = movies.filter(x => x.id !== id);
  renderGrid();
  updateStats();

  try {
    await supa.delete(TABLE, `id=eq.${id}`);
    if (m.storage_path) await supa.deleteFile(m.storage_path);
    await idbDelete(id);
    showToast('Film supprimé de Supabase', 'info');
  } catch (e) {
    console.error('Delete error:', e);
    showToast('Film supprimé localement (erreur Supabase)', 'error');
  }
}

// =====================================================================
// Convert to MP4 — FFmpeg.wasm (AVI, MKV, MOV, WMV, etc.)
// =====================================================================

let ffmpegInstance = null;

/** Charge FFmpeg.wasm depuis CDN (une seule fois) */
async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;

  setProgress(0, 'Chargement de FFmpeg...');
  showToast('⏳ Chargement de FFmpeg (~30 MB, une seule fois)...', 'info');

  const { FFmpeg }    = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
  const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js');

  const ff = new FFmpeg();

  // Progression globale 0→1 fournie par FFmpeg.wasm
  ff.on('progress', ({ progress }) => {
    const pct     = Math.min(99, Math.round(progress * 100));
    const elapsed = (performance.now() - convertStats.startTime) / 1000;
    setProgress(pct, `Conversion : ${pct}%`);
    document.getElementById('stat-elapsed').textContent = formatDuration(elapsed);
    if (pct > 1) {
      const remaining = (elapsed / pct) * (100 - pct);
      document.getElementById('stat-remaining').textContent = formatDuration(remaining);
    }
  });

  // Logs FFmpeg ligne par ligne :
  // frame=  240 fps= 48 q=23.0 size=    3072kB time=00:00:10.01 bitrate=2514.5kbits/s speed=2.01x
  ff.on('log', ({ message }) => {
    // FPS d'encodage
    const fpsM = message.match(/fps=\s*([\d.]+)/);
    if (fpsM && parseFloat(fpsM[1]) > 0)
      document.getElementById('stat-fps').textContent = parseFloat(fpsM[1]).toFixed(0) + ' fps';

    // Taille générée (kB → bytes)
    const sizeM = message.match(/size=\s*([\d.]+)\s*[kK][bB]/);
    if (sizeM) {
      const bytes = parseFloat(sizeM[1]) * 1024;
      const now   = performance.now();
      const dt    = (now - convertStats.lastByteTime) / 1000;

      // MB/s = delta taille / delta temps
      if (dt >= 0.3 && bytes > convertStats.lastBytes) {
        const mbps = (bytes - convertStats.lastBytes) / dt / 1048576;
        document.getElementById('stat-speed').textContent = mbps.toFixed(2) + ' MB/s';
        convertStats.lastBytes    = bytes;
        convertStats.lastByteTime = now;
      } else if (convertStats.lastBytes === 0) {
        convertStats.lastBytes    = bytes;
        convertStats.lastByteTime = now;
      }

      convertStats.bytesWritten = bytes;
      document.getElementById('stat-written').textContent = formatSize(bytes);
    }
  });

  // Charger les wasm core depuis CDN
  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/esm';
  await ff.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`,   'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  ffmpegInstance = { ff };
  return ffmpegInstance;
}

function resetConvertUI() {
  document.getElementById('convertProgress').style.display = 'none';
  document.getElementById('convertResult').style.display   = 'none';
  document.getElementById('progressFill').style.width      = '0%';
  document.getElementById('progressPct').textContent       = '0%';
  document.getElementById('progressLabel').textContent     = 'Traitement...';
  const btn = document.getElementById('convertBtn');
  btn.disabled    = false;
  btn.textContent = 'Convertir en MP4';
  stopStatsTimer();
  resetStatsDisplay();
}

function stopStatsTimer() {
  if (convertStats.timerInterval) { clearInterval(convertStats.timerInterval); convertStats.timerInterval = null; }
}

function resetStatsDisplay() {
  document.getElementById('stat-elapsed').textContent   = '0:00';
  document.getElementById('stat-remaining').textContent = '—';
  document.getElementById('stat-speed').textContent     = '— MB/s';
  document.getElementById('stat-fps').textContent       = '— fps';
  document.getElementById('stat-written').textContent   = '0 MB';
  document.querySelectorAll('.stat-box').forEach(b => b.classList.remove('active'));
}

function startStatsTimer() {
  convertStats.startTime    = performance.now();
  convertStats.lastByteTime = performance.now();
  convertStats.lastBytes    = 0;
  convertStats.bytesWritten = 0;
  convertStats.frameCount   = 0;
  document.querySelectorAll('.stat-box').forEach(b => b.classList.add('active'));
  // Le timer met juste à jour le temps écoulé chaque seconde
  // Les autres stats (MB/s, taille, fps) sont mises à jour en temps réel par les logs FFmpeg
  convertStats.timerInterval = setInterval(() => {
    const elapsed = (performance.now() - convertStats.startTime) / 1000;
    document.getElementById('stat-elapsed').textContent = formatDuration(elapsed);
  }, 1000);
}

function formatDuration(s) {
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

async function convertCurrentMovie() {
  if (!currentMovie) return;
  const btn = document.getElementById('convertBtn');
  btn.disabled = true; btn.textContent = 'Chargement FFmpeg...';
  document.getElementById('convertProgress').style.display = 'block';
  document.getElementById('convertResult').style.display   = 'none';

  try {
    await runFFmpegConversion();
  } catch (err) {
    handleConversionError(err);
  }
}

async function runFFmpegConversion() {
  const btn = document.getElementById('convertBtn');
  btn.textContent = 'Conversion...';

  // Qualité → CRF FFmpeg (plus bas = meilleure qualité)
  const crf = { high: '18', medium: '23', low: '28' };
  const quality = document.getElementById('qualitySelect').value;

  // Charger FFmpeg
  const { ff, fetchFile } = await loadFFmpeg();

  startStatsTimer();
  setProgress(1, 'Lecture du fichier source...');

  // Récupérer le blob source
  let sourceData;
  const url = currentMovie.url;
  if (url.startsWith('blob:')) {
    const cached = await idbGet(currentMovie.id);
    if (cached && cached.blob) {
      sourceData = await cached.blob.arrayBuffer();
    } else {
      const res  = await fetch(url);
      sourceData = await res.arrayBuffer();
    }
  } else {
    // URL Supabase — fetch direct
    showToast('⬇ Téléchargement depuis Supabase...', 'info');
    const res  = await fetch(url);
    sourceData = await res.arrayBuffer();
  }

  const ext    = currentMovie.ext.toLowerCase();
  const inFile = `input.${ext}`;
  const outFile = 'output.mp4';

  setProgress(3, 'Écriture dans FFmpeg...');
  await ff.writeFile(inFile, new Uint8Array(sourceData));

  setProgress(5, 'Conversion en cours...');
  btn.textContent = 'Conversion...';

  // Commande FFmpeg : re-encode en H.264 / AAC, compatible partout
  await ff.exec([
    '-i', inFile,
    '-c:v', 'libx264',
    '-crf', crf[quality] || '23',
    '-preset', 'fast',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    '-y',
    outFile,
  ]);

  setProgress(98, 'Finalisation...');

  // Lire le résultat
  const data    = await ff.readFile(outFile);
  const blob    = new Blob([data.buffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  const outName = currentMovie.title + '_converti.mp4';

  // Nettoyage mémoire FFmpeg
  try { await ff.deleteFile(inFile);  } catch {}
  try { await ff.deleteFile(outFile); } catch {}

  stopStatsTimer();
  setProgress(100, 'Conversion terminée !');

  const totalElapsed = (performance.now() - convertStats.startTime) / 1000;
  document.getElementById('stat-elapsed').textContent   = formatDuration(totalElapsed);
  document.getElementById('stat-remaining').textContent = '0:00';
  document.getElementById('stat-written').textContent   = formatSize(blob.size);  // taille réelle finale
  document.getElementById('stat-speed').textContent     = '—';
  document.getElementById('stat-fps').textContent       = '—';

  window._lastConvertedBlob = blob;
  showConvertSuccess(blobUrl, outName, blob.size);
  showToast('✓ Conversion réussie !', 'success');
  btn.textContent = 'Reconvertir';
  btn.disabled    = false;
}

function setProgress(pct, label) {
  document.getElementById('progressFill').style.width  = pct + '%';
  document.getElementById('progressPct').textContent   = pct + '%';
  document.getElementById('progressLabel').textContent = label;
}

function showConvertSuccess(url, name, size) {
  const div = document.getElementById('convertResult');
  div.style.display = 'block';
  div.innerHTML = `
    <div class="result-success">
      <span class="result-icon">✓</span>
      <span class="result-text">Conversion terminée — <strong>${name}</strong> (${formatSize(size)})</span>
      <button class="btn btn-primary"   onclick="triggerDownload('${url}','${name}')">⬇ Télécharger</button>
      <button class="btn btn-secondary" onclick="addConverted('${url}','${name}',${size})">☁ Ajouter & synchroniser</button>
    </div>`;
}

function handleConversionError(err) {
  stopStatsTimer();
  console.error('[FFmpeg]', err);
  showToast('Erreur : ' + err.message, 'error');
  const btn = document.getElementById('convertBtn');
  btn.textContent = 'Convertir en MP4'; btn.disabled = false;
  const div = document.getElementById('convertResult');
  div.style.display = 'block';
  div.innerHTML = `
    <div class="result-warning">
      ⚠ Erreur de conversion : <em>${err.message}</em><br><br>
      Si le problème persiste, téléchargez le fichier et utilisez
      <a href="https://www.handbrake.fr" target="_blank">HandBrake</a> (gratuit).<br><br>
      <button class="btn btn-secondary" onclick="downloadCurrentMovie()" style="width:auto">⬇ Télécharger l'original</button>
    </div>`;
}

async function addConverted(url, name, size) {
  const blob = window._lastConvertedBlob;
  if (!blob) { showToast('⚠ Fichier converti introuvable', 'error'); return; }
  const file = new File([blob], name, { type: blob.type });
  await addMovie(file);
}

// =====================================================================
// Toast Notifications
// =====================================================================

function showToast(message, type = 'info') {
  const icons     = { success: '✅', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toastContainer');
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}
