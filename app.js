/* =====================================================================
   MaCinémathèque — app.js  v4
   Stockage vidéo : Terabox (1 TB gratuit) via proxy Render
   Métadonnées    : Supabase
   Cache local    : IndexedDB
   Conversion     : FFmpeg.wasm (AVI, MKV, MOV, etc.)
   ===================================================================== */

// =====================================================================
// CONFIG — À remplir
// =====================================================================

const CONFIG = {
  proxyUrl:  'https://proxy-tera-box-streaming-privee.onrender.com',
  ndus:      'Y2rf4r3teHuip84PqEcd5Q418kgZU2dOsqLd_9cM',
  jsToken:   'F3063036A4C7F1EE34E88C07B08833D5B639780B6BFE6218F4B06AEA5AE18C1CF688DF889BB329F8A87FD1E9DCE6EB20CFE668561963F1AF613B63F0336E6E6F',
  appId:     '250528',
  browserId: 'AD8vpD6GQgZiKgIIySDIDz_V__gdukEtZdGa6e8ULxWitqfiPI2dDHeAsME=',
  remoteDir: '/MaCinematheque',
  supabaseUrl:  'https://olhfduqnxhaoaxcxjxxi.supabase.co',
  supabaseAnon: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9saGZkdXFueGhhb2F4Y3hqeHhpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMDI3NTgsImV4cCI6MjA4NzY3ODc1OH0.gJokdFbBt5k9DuHBkMRtxhHcNQNJlyOjXnXMNu-Q-1k',
};

// Taille de chaque chunk d'upload : 10 MB
// (le chunk est encodé en base64 → x1.33, soit ~13 MB de JSON au proxy)
// Render free tier coupe à 30s → 10 MB est le bon compromis vitesse/fiabilité
const CHUNK_SIZE = 10 * 1024 * 1024;

// =====================================================================
// Supabase helpers
// =====================================================================

const supa = {
  h: () => ({
    'apikey':        CONFIG.supabaseAnon,
    'Authorization': 'Bearer ' + CONFIG.supabaseAnon,
    'Content-Type':  'application/json',
  }),
  async select(q = '') {
    const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/movies?${q}`, { headers: this.h() });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async insert(row) {
    const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/movies`, {
      method: 'POST',
      headers: { ...this.h(), 'Prefer': 'return=representation' },
      body: JSON.stringify(row),
    });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  },
  async delete(id) {
    const r = await fetch(`${CONFIG.supabaseUrl}/rest/v1/movies?id=eq.${id}`, {
      method: 'DELETE', headers: this.h(),
    });
    if (!r.ok) throw new Error(await r.text());
  },
};

// =====================================================================
// Terabox helpers (via proxy)
// =====================================================================

const tera = {
  creds() {
    return {
      ndus:      CONFIG.ndus,
      jsToken:   CONFIG.jsToken,
      appId:     CONFIG.appId,
      browserId: CONFIG.browserId,
    };
  },

  async post(endpoint, body) {
    const r = await fetch(`${CONFIG.proxyUrl}/terabox/${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ ...this.creds(), ...body }),
    });
    if (!r.ok) throw new Error(`Proxy error ${r.status}: ${await r.text()}`);
    return r.json();
  },

  async get(endpoint, params = {}) {
    const q = new URLSearchParams({ ...this.creds(), ...params });
    const r = await fetch(`${CONFIG.proxyUrl}/terabox/${endpoint}?${q}`);
    if (!r.ok) throw new Error(`Proxy error ${r.status}: ${await r.text()}`);
    return r.json();
  },

  /** Calcule le vrai MD5 d'un ArrayBuffer (requis par l'API Terabox) */
  async md5(buffer) {
    // crypto.subtle ne supporte pas MD5 (obsolète) — implémentation JS pure
    function md5js(buf) {
      const b = new Uint8Array(buf);
      function safeAdd(x, y) { const l = (x & 0xffff) + (y & 0xffff); return (((x >> 16) + (y >> 16) + (l >> 16)) << 16) | (l & 0xffff); }
      function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
      function cmn(q, a, b, x, s, t) { return safeAdd(rol(safeAdd(safeAdd(a, q), safeAdd(x, t)), s), b); }
      function ff(a,b,c,d,x,s,t){ return cmn((b&c)|((~b)&d),a,b,x,s,t); }
      function gg(a,b,c,d,x,s,t){ return cmn((b&d)|(c&(~d)),a,b,x,s,t); }
      function hh(a,b,c,d,x,s,t){ return cmn(b^c^d,a,b,x,s,t); }
      function ii(a,b,c,d,x,s,t){ return cmn(c^(b|(~d)),a,b,x,s,t); }
      const orig = b.length;
      const len  = orig + 1;
      const extra = (len % 64 < 56 ? 56 - len % 64 : 120 - len % 64);
      const padded = new Uint8Array(len + extra + 8);
      padded.set(b); padded[orig] = 0x80;
      const bits = orig * 8;
      padded[len + extra]     = bits & 0xff;
      padded[len + extra + 1] = (bits >>> 8)  & 0xff;
      padded[len + extra + 2] = (bits >>> 16) & 0xff;
      padded[len + extra + 3] = (bits >>> 24) & 0xff;
      const words = new Int32Array(padded.buffer);
      let a = 0x67452301, bv = 0xefcdab89, c = 0x98badcfe, d = 0x10325476;
      for (let i = 0; i < words.length; i += 16) {
        const [oa,ob,oc,od] = [a,bv,c,d];
        a=ff(a,bv,c,d,words[i+0],7,-680876936);d=ff(d,a,bv,c,words[i+1],12,-389564586);c=ff(c,d,a,bv,words[i+2],17,606105819);bv=ff(bv,c,d,a,words[i+3],22,-1044525330);
        a=ff(a,bv,c,d,words[i+4],7,-176418897);d=ff(d,a,bv,c,words[i+5],12,1200080426);c=ff(c,d,a,bv,words[i+6],17,-1473231341);bv=ff(bv,c,d,a,words[i+7],22,-45705983);
        a=ff(a,bv,c,d,words[i+8],7,1770035416);d=ff(d,a,bv,c,words[i+9],12,-1958414417);c=ff(c,d,a,bv,words[i+10],17,-42063);bv=ff(bv,c,d,a,words[i+11],22,-1990404162);
        a=ff(a,bv,c,d,words[i+12],7,1804603682);d=ff(d,a,bv,c,words[i+13],12,-40341101);c=ff(c,d,a,bv,words[i+14],17,-1502002290);bv=ff(bv,c,d,a,words[i+15],22,1236535329);
        a=gg(a,bv,c,d,words[i+1],5,-165796510);d=gg(d,a,bv,c,words[i+6],9,-1069501632);c=gg(c,d,a,bv,words[i+11],14,643717713);bv=gg(bv,c,d,a,words[i+0],20,-373897302);
        a=gg(a,bv,c,d,words[i+5],5,-701558691);d=gg(d,a,bv,c,words[i+10],9,38016083);c=gg(c,d,a,bv,words[i+15],14,-660478335);bv=gg(bv,c,d,a,words[i+4],20,-405537848);
        a=gg(a,bv,c,d,words[i+9],5,568446438);d=gg(d,a,bv,c,words[i+14],9,-1019803690);c=gg(c,d,a,bv,words[i+3],14,-187363961);bv=gg(bv,c,d,a,words[i+8],20,1163531501);
        a=gg(a,bv,c,d,words[i+13],5,-1444681467);d=gg(d,a,bv,c,words[i+2],9,-51403784);c=gg(c,d,a,bv,words[i+7],14,1735328473);bv=gg(bv,c,d,a,words[i+12],20,-1926607734);
        a=hh(a,bv,c,d,words[i+5],4,-378558);d=hh(d,a,bv,c,words[i+8],11,-2022574463);c=hh(c,d,a,bv,words[i+11],16,1839030562);bv=hh(bv,c,d,a,words[i+14],23,-35309556);
        a=hh(a,bv,c,d,words[i+1],4,-1530992060);d=hh(d,a,bv,c,words[i+4],11,1272893353);c=hh(c,d,a,bv,words[i+7],16,-155497632);bv=hh(bv,c,d,a,words[i+10],23,-1094730640);
        a=hh(a,bv,c,d,words[i+13],4,681279174);d=hh(d,a,bv,c,words[i+0],11,-358537222);c=hh(c,d,a,bv,words[i+3],16,-722521979);bv=hh(bv,c,d,a,words[i+6],23,76029189);
        a=hh(a,bv,c,d,words[i+9],4,-640364487);d=hh(d,a,bv,c,words[i+12],11,-421815835);c=hh(c,d,a,bv,words[i+15],16,530742520);bv=hh(bv,c,d,a,words[i+2],23,-995338651);
        a=ii(a,bv,c,d,words[i+0],6,-198630844);d=ii(d,a,bv,c,words[i+7],10,1126891415);c=ii(c,d,a,bv,words[i+14],15,-1416354905);bv=ii(bv,c,d,a,words[i+5],21,-57434055);
        a=ii(a,bv,c,d,words[i+12],6,1700485571);d=ii(d,a,bv,c,words[i+3],10,-1894986606);c=ii(c,d,a,bv,words[i+10],15,-1051523);bv=ii(bv,c,d,a,words[i+1],21,-2054922799);
        a=ii(a,bv,c,d,words[i+8],6,1873313359);d=ii(d,a,bv,c,words[i+15],10,-30611744);c=ii(c,d,a,bv,words[i+6],15,-1560198380);bv=ii(bv,c,d,a,words[i+13],21,1309151649);
        a=ii(a,bv,c,d,words[i+4],6,-145523070);d=ii(d,a,bv,c,words[i+11],10,-1120210379);c=ii(c,d,a,bv,words[i+2],15,718787259);bv=ii(bv,c,d,a,words[i+9],21,-343485551);
        a=safeAdd(a,oa);bv=safeAdd(bv,ob);c=safeAdd(c,oc);d=safeAdd(d,od);
      }
      const out = new Uint8Array(16);
      new DataView(out.buffer).setInt32(0,a,true); new DataView(out.buffer).setInt32(4,bv,true);
      new DataView(out.buffer).setInt32(8,c,true); new DataView(out.buffer).setInt32(12,d,true);
      return out;
    }
    return Array.from(md5js(buffer)).map(b => b.toString(16).padStart(2,'0')).join('');
  },

  /** Réveille le proxy Render (cold start ~30s sur plan gratuit) */
  async wakeUp() {
    showSyncBanner('⏳ Réveil du serveur (Render cold start)...');
    try {
      const start = Date.now();
      await fetch(`${CONFIG.proxyUrl}/health`, { signal: AbortSignal.timeout(70000) });
      const ms = Date.now() - start;
      if (ms > 3000) showToast(`⚡ Serveur réveillé en ${(ms/1000).toFixed(1)}s`, 'info');
    } catch {}
    hideSyncBanner();
  },

  /** Upload complet d'un fichier vers Terabox (multipart) */
  async upload(file, remotePath, onProgress) {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const blockList   = [];
    const startTime   = Date.now();

    // Étape 1 : précréer
    onProgress(0, `Précréation Terabox (${totalChunks} chunks)...`);
    updateDiag('terabox', 'pending', `⏳ Précréation (${formatSize(file.size)}, ${totalChunks} chunks)...`);

    const pre = await this.post('precreate', {
      path:      remotePath,
      size:      file.size,
      blockList: ['5910a591dd8fc18c32a8f3df4ad24ea8'],
    });

    if (pre.errno && pre.errno !== 0) throw new Error('Precreate échoué errno=' + pre.errno + ' : ' + JSON.stringify(pre));
    const uploadId = pre.uploadid;

    // Étape 2 : upload des chunks avec retry
    for (let i = 0; i < totalChunks; i++) {
      const start  = i * CHUNK_SIZE;
      const end    = Math.min(start + CHUNK_SIZE, file.size);
      const chunk  = file.slice(start, end);
      const buffer = await chunk.arrayBuffer();
      const md5    = await this.md5(buffer);
      blockList.push(md5);

      // Encoder en base64 par sous-blocs de 8 KB (évite stack overflow)
      const bytes = new Uint8Array(buffer);
      let binary = '';
      const BTOA_CHUNK = 8192;
      for (let j = 0; j < bytes.length; j += BTOA_CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(j, Math.min(j + BTOA_CHUNK, bytes.length)));
      }
      const base64 = btoa(binary);

      // Calcul vitesse
      const elapsed  = (Date.now() - startTime) / 1000;
      const uploaded  = start;
      const speed     = elapsed > 1 ? uploaded / elapsed : 0;
      const remaining = speed > 0 ? (file.size - uploaded) / speed : 0;
      const speedStr  = speed > 0 ? formatSize(speed) + '/s' : '...';
      const pct       = Math.round(((i + 0.5) / totalChunks) * 90);

      const label = `Chunk ${i + 1}/${totalChunks} — ${speedStr} — reste ~${formatDuration(remaining)}`;
      onProgress(pct, label);
      updateDiag('terabox', 'pending', `⬆ ${i + 1}/${totalChunks} chunks — ${speedStr}`);

      // Upload avec retry (3 tentatives)
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const up = await this.post('upload', {
            path: remotePath, uploadId, partseq: i, chunkBase64: base64, md5,
          });
          if (up.error_code && up.error_code !== 0) throw new Error('error_code=' + up.error_code);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          updateDiag('terabox', 'pending', `⚠ Chunk ${i + 1} tentative ${attempt}/3 — ${e.message.slice(0, 60)}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
      if (lastErr) throw new Error(`Chunk ${i + 1}/${totalChunks} échoué après 3 tentatives : ${lastErr.message}`);
    }

    // Étape 3 : finaliser
    onProgress(95, 'Finalisation Terabox...');
    updateDiag('terabox', 'pending', '⏳ Finalisation...');
    const create = await this.post('create', { path: remotePath, size: file.size, uploadId, blockList });
    if (create.errno && create.errno !== 0) throw new Error('Create échoué errno=' + create.errno + ' : ' + JSON.stringify(create));

    onProgress(100, 'Upload terminé !');
    return { fsId: create.fs_id || create.fsid, path: remotePath };
  },

  /** Créer le dossier si besoin */
  async ensureDir() {
    try { await this.post('mkdir', { path: CONFIG.remoteDir }); } catch {}
  },
  async getDlink(fsId) {
    const data = await this.get('dlink', { fsId });
    if (!data.dlink) throw new Error('Pas de dlink');
    return data.dlink;
  },

  /** Supprimer un fichier */
  async deleteFile(path) {
    return this.post('delete', { filelist: [path] });
  },

  /** Réveille le proxy Render (cold start ~15s) et teste la connexion */
  async wakeUp() {
    updateDiag('proxy', 'pending', '⏳ Connexion au proxy...');
    try {
      const r = await fetch(`${CONFIG.proxyUrl}/health`, { signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      updateDiag('proxy', 'ok', '✅ Proxy connecté');
    } catch (e) {
      updateDiag('proxy', 'error', '❌ Proxy injoignable : ' + e.message);
      throw new Error('Proxy injoignable — vérifie que ton service Render est démarré. (' + e.message + ')');
    }
  },

  /** Teste l'auth Terabox */
  async testTerabox() {
    updateDiag('terabox', 'pending', '⏳ Test Terabox...');
    try {
      const data = await this.get('list', { dir: '/' });
      if (data.errno && data.errno !== 0) throw new Error('errno=' + data.errno + ' — token expiré ?');
      updateDiag('terabox', 'ok', '✅ Terabox authentifié');
    } catch (e) {
      updateDiag('terabox', 'error', '❌ Terabox : ' + e.message);
      throw new Error('Authentification Terabox échouée — vérifie ndus et jsToken. (' + e.message + ')');
    }
  },
};

// =====================================================================
// IndexedDB — cache local
// =====================================================================

const DB_NAME = 'macinema_db';
let   idb     = null;

function openIDB() {
  return new Promise((res, rej) => {
    if (idb) return res(idb);
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('blobs'))
        d.createObjectStore('blobs', { keyPath: 'id' });
    };
    req.onsuccess = e => { idb = e.target.result; res(idb); };
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbPut(id, blob) {
  const d = await openIDB();
  return new Promise((res, rej) => {
    const tx  = d.transaction('blobs', 'readwrite');
    const req = tx.objectStore('blobs').put({ id, blob });
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbGet(id) {
  const d = await openIDB();
  return new Promise((res, rej) => {
    const tx  = d.transaction('blobs', 'readonly');
    const req = tx.objectStore('blobs').get(id);
    req.onsuccess = e => res(e.target.result);
    req.onerror   = e => rej(e.target.error);
  });
}

async function idbDelete(id) {
  const d = await openIDB();
  return new Promise((res, rej) => {
    const tx  = d.transaction('blobs', 'readwrite');
    const req = tx.objectStore('blobs').delete(id);
    req.onsuccess = () => res();
    req.onerror   = e => rej(e.target.error);
  });
}

// =====================================================================
// State
// =====================================================================

let movies       = [];
const fileStore  = {};  // id → URL locale ou dlink Terabox
let currentMovie = null;

const convertStats = {
  startTime: 0, frameCount: 0, bytesWritten: 0,
  lastBytes: 0, lastByteTime: 0, timerInterval: null,
};

// =====================================================================
// Init
// =====================================================================

(async function init() {
  // Vérifier la config
  if (!CONFIG.ndus || !CONFIG.jsToken) {
    showConfigWarning();
  }

  showSyncBanner('Chargement de la collection...');
  setupDropzone();

  try {
    const rows = await supa.select('order=added_at.desc');
    movies = rows.map(r => ({
      id: r.id, name: r.name, title: r.title,
      size: r.size, ext: r.ext, added: r.added,
      terabox_path: r.terabox_path, fs_id: r.fs_id,
    }));

    // Restaurer URLs depuis cache local d'abord
    for (const m of movies) {
      try {
        const cached = await idbGet(m.id);
        if (cached?.blob) fileStore[m.id] = URL.createObjectURL(cached.blob);
      } catch {}
    }

    hideSyncBanner();
    if (movies.length) showToast(`✓ ${movies.length} film(s) chargé(s)`, 'success');
  } catch (e) {
    hideSyncBanner();
    showToast('⚠ Impossible de charger la collection Supabase', 'error');
    console.error(e);
  }

  renderGrid();
  updateStats();
})();

// =====================================================================
// Panneau de diagnostic de connexion
// =====================================================================

function showDiagPanel() {
  if (document.getElementById('diagPanel')) return;
  const panel = document.createElement('div');
  panel.id = 'diagPanel';
  panel.style.cssText = `
    position:fixed;bottom:16px;right:16px;z-index:9999;
    background:#0f1219;border:1px solid #1e2535;border-radius:10px;
    padding:14px 18px;font-size:0.75rem;color:#aab;
    box-shadow:0 4px 24px rgba(0,0,0,0.6);min-width:240px;
  `;
  panel.innerHTML = `
    <div style="font-weight:700;color:#e2e8f0;margin-bottom:10px;font-size:0.8rem">🔌 Diagnostic connexion</div>
    <div id="diag-proxy"   style="margin:4px 0">⏳ Proxy...</div>
    <div id="diag-terabox" style="margin:4px 0">⏳ Terabox...</div>
    <button onclick="document.getElementById('diagPanel').remove()" 
      style="margin-top:10px;background:none;border:1px solid #2d3748;color:#6b7385;
             padding:3px 10px;border-radius:4px;cursor:pointer;font-size:0.7rem;width:100%">Fermer</button>
  `;
  document.body.appendChild(panel);
}

function updateDiag(key, status, msg) {
  const el = document.getElementById('diag-' + key);
  if (!el) return;
  const colors = { pending: '#e8b86d', ok: '#48bb78', error: '#fc8181' };
  el.style.color = colors[status] || '#aab';
  el.textContent = msg;
}

function hideDiagPanel(delay = 3000) {
  setTimeout(() => {
    const p = document.getElementById('diagPanel');
    if (p) { p.style.transition = 'opacity 0.5s'; p.style.opacity = '0'; setTimeout(() => p?.remove(), 500); }
  }, delay);
}

// =====================================================================
// Config Warning
// =====================================================================

function showConfigWarning() {
  const banner = document.createElement('div');
  banner.id = 'configBanner';
  banner.style.cssText = `
    position:fixed;bottom:0;left:0;right:0;z-index:9997;
    background:#1a1200;border-top:2px solid #e8b86d;
    padding:14px 48px;font-size:0.75rem;color:#e8b86d;
    display:flex;align-items:center;gap:16px;
  `;
  banner.innerHTML = `
    <span>⚙</span>
    <span>Tokens Terabox non configurés. Remplis <strong>CONFIG.ndus</strong> et <strong>CONFIG.jsToken</strong> dans app.js</span>
    <button onclick="document.getElementById('configBanner').remove()" style="margin-left:auto;background:none;border:1px solid #e8b86d;color:#e8b86d;padding:4px 12px;border-radius:4px;cursor:pointer;font-size:0.7rem">Fermer</button>
  `;
  document.body.appendChild(banner);
}

// =====================================================================
// Sync Banner
// =====================================================================

function showSyncBanner(msg) {
  let b = document.getElementById('syncBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'syncBanner';
    b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:9998;background:linear-gradient(90deg,#1e2535,#0f1219);border-bottom:1px solid #1e2535;padding:8px 48px;font-size:0.7rem;color:#6b7385;display:flex;align-items:center;gap:10px;`;
    b.innerHTML = `<span style="display:inline-block;animation:spin 1s linear infinite">⟳</span><span id="syncMsg">${msg}</span>`;
    document.body.prepend(b);
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
  ['dragenter', 'dragover'].forEach(e =>
    dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.add('drag'); })
  );
  ['dragleave', 'drop'].forEach(e =>
    dz.addEventListener(e, ev => { ev.preventDefault(); dz.classList.remove('drag'); })
  );
  dz.addEventListener('drop', e => handleFiles(e.dataTransfer.files));
}

// =====================================================================
// File Handling
// =====================================================================

function handleFiles(files) {
  if (!files.length) return;
  Array.from(files).forEach(file => addMovie(file));
  switchTabDirect('library');
}

function isVideoExtension(name) {
  return true; // aucune restriction
}

async function addMovie(file) {
  if (!CONFIG.ndus || !CONFIG.jsToken) {
    showToast('⚠ Configure tes tokens Terabox dans app.js', 'error');
    return;
  }

  const id         = 'mv_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const ext        = file.name.split('.').pop().toUpperCase();
  const remotePath = `${CONFIG.remoteDir}/${id}_${file.name}`;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  const movie = {
    id, name: file.name, title: cleanTitle(file.name),
    size: file.size, ext, added: new Date().toLocaleDateString('fr-FR'),
    terabox_path: remotePath, fs_id: null, uploading: true,
  };

  // UI optimiste
  fileStore[id] = URL.createObjectURL(file);
  movies.unshift(movie);
  renderGrid(); updateStats();

  // Afficher le panneau de diagnostic
  showDiagPanel();

  try {
    // Étape 1 : réveil + test proxy
    await tera.wakeUp();

    // Étape 2 : test Terabox
    await tera.testTerabox();

    // Étape 3 : dossier distant
    await tera.ensureDir();

    // Étape 4 : upload avec progression chunk par chunk
    const { fsId } = await tera.upload(file, remotePath, (pct, label) => {
      const card = document.querySelector(`[data-id="${id}"]`);
      if (card) updateCardProgress(card, pct, label);
    });

    movie.fs_id     = fsId;
    movie.uploading = false;

    updateDiag('terabox', 'ok', `✅ Upload terminé (${totalChunks} chunk${totalChunks > 1 ? 's' : ''})`);
    hideDiagPanel(2000);

    // Sauvegarder en Supabase
    await supa.insert({
      id, name: movie.name, title: movie.title,
      size: movie.size, ext: movie.ext, added: movie.added,
      terabox_path: remotePath, fs_id: fsId,
    });

    // Cache local
    await idbPut(id, file);

    renderGrid();
    showToast('✓ ' + movie.title + ' uploadé sur Terabox !', 'success');

  } catch (e) {
    console.error('Upload error:', e);
    movie.uploading    = false;
    movie.terabox_path = null;
    renderGrid();
    showToast('⚠ Upload échoué : ' + e.message, 'error');
    // Laisser le panneau visible pour voir l'erreur
  }
}

function updateCardProgress(card, pct, label) {
  let bar = card.querySelector('.upload-progress-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.className = 'upload-progress-bar';
    bar.innerHTML = `<div class="upload-progress-fill"></div><span class="upload-progress-label"></span>`;
    card.querySelector('.movie-thumb').appendChild(bar);
  }
  bar.querySelector('.upload-progress-fill').style.width = pct + '%';
  bar.querySelector('.upload-progress-label').textContent = label;
}

function cleanTitle(filename) {
  return filename.replace(/\.[^.]+$/, '').replace(/[._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  document.getElementById('stat-size').textContent  = formatSize(movies.reduce((s, m) => s + (m.size || 0), 0));
}

// =====================================================================
// Render Grid
// =====================================================================

function renderGrid(filter = '') {
  const grid  = document.getElementById('movieGrid');
  const empty = document.getElementById('emptyState');
  const label = document.getElementById('film-count-label');

  const visible = filter ? movies.filter(m => m.title.toLowerCase().includes(filter.toLowerCase())) : movies;
  label.textContent = movies.length ? `(${movies.length})` : '';

  if (!movies.length) {
    grid.style.display  = 'none';
    empty.style.display = 'block';
    empty.innerHTML = `<div class="big-icon">🎞</div><h3>Votre collection est vide</h3>
      <p>Ajoutez vos films via l'onglet <strong class="accent">Ajouter</strong><br>
      Stockage Terabox — 1 TB gratuit</p>`;
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
  const badge = m.uploading
    ? `<div class="sync-badge uploading">⬆ Upload...</div>`
    : m.terabox_path
      ? `<div class="sync-badge">☁ Terabox</div>`
      : `<div class="offline-badge">⚠ Local</div>`;

  return `
    <div class="movie-card" data-id="${m.id}">
      <div class="movie-thumb">
        ${available && !m.uploading
          ? `<video src="${fileStore[m.id]}" preload="metadata" muted
               style="width:100%;height:100%;object-fit:cover;position:absolute;inset:0"></video>` : ''}
        <div style="position:relative;z-index:1;font-size:2.5rem;opacity:${available && !m.uploading ? 0 : 0.3}">🎬</div>
        <div class="play-overlay" onclick="openPlayer('${m.id}')">▶</div>
        <div class="movie-format">${m.ext}</div>
        ${badge}
      </div>
      <div class="movie-info">
        <h3 title="${m.title}">${m.title}</h3>
        <div class="meta"><span>${formatSize(m.size)}</span><span>${m.added}</span></div>
      </div>
      <div class="movie-actions">
        <button class="btn btn-primary"   onclick="openPlayer('${m.id}')"   ${m.uploading ? 'disabled' : ''}>▶ Lire</button>
        <button class="btn btn-secondary" onclick="downloadById('${m.id}')" ${m.uploading ? 'disabled' : ''}>⬇</button>
        <button class="btn btn-danger"    onclick="deleteMovie('${m.id}')"  ${m.uploading ? 'disabled' : ''}>🗑</button>
      </div>
    </div>`;
}

function filterMovies(value) { renderGrid(value); }

// =====================================================================
// Player
// =====================================================================

async function openPlayer(id) {
  const movie = movies.find(m => m.id === id);
  if (!movie) return;

  let url = fileStore[id];

  // Si pas de URL locale (blob), récupérer le dlink Terabox
  if (!url || url.startsWith('http')) {
    if (movie.fs_id) {
      showToast('⏳ Récupération du lien de lecture...', 'info');
      try {
        url = await tera.getDlink(movie.fs_id);
        fileStore[id] = url; // mis en cache (expire après ~8h, raisonnablement ok)
      } catch (e) {
        showToast('⚠ Impossible de lire le film : ' + e.message, 'error');
        return;
      }
    } else if (!url) {
      showToast('Fichier non disponible (pas de lien Terabox ni de cache local)', 'error');
      return;
    }
  }

  currentMovie = { ...movie, url };
  document.getElementById('modalTitle').textContent  = movie.title;
  document.getElementById('meta-name').textContent   = movie.name;
  document.getElementById('meta-size').textContent   = formatSize(movie.size);
  document.getElementById('meta-format').textContent = movie.ext;

  const player = document.getElementById('mainPlayer');
  player.removeAttribute('crossorigin');
  player.src = url;
  player.load();
  player.play().catch(() => {});

  resetConvertUI();
  document.getElementById('playerModal').classList.add('open');
}

function closeModal() {
  const player = document.getElementById('mainPlayer');
  player.pause(); player.src = '';
  document.getElementById('playerModal').classList.remove('open');
  currentMovie = null;
}

document.getElementById('playerModal').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

// =====================================================================
// Download
// =====================================================================

function downloadCurrentMovie() {
  if (!currentMovie) return;
  triggerDownload(currentMovie.url, currentMovie.name);
}

async function downloadById(id) {
  const m = movies.find(x => x.id === id);
  if (!m) { showToast('Film introuvable', 'error'); return; }
  let url = fileStore[id];
  if (!url && m.fs_id) {
    showToast('⏳ Génération du lien...', 'info');
    try {
      url = await tera.getDlink(m.fs_id);
      fileStore[id] = url;
    } catch (e) {
      showToast('⚠ Impossible de télécharger : ' + e.message, 'error'); return;
    }
  }
  if (url) triggerDownload(url, m.name);
  else showToast('Aucun lien disponible', 'error');
}

function triggerDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
}

// =====================================================================
// Delete
// =====================================================================

async function deleteMovie(id) {
  const m = movies.find(x => x.id === id);
  if (!m || !confirm(`Supprimer "${m.title}" ?`)) return;

  if (fileStore[id] && !fileStore[id].startsWith('http')) URL.revokeObjectURL(fileStore[id]);
  delete fileStore[id];
  movies = movies.filter(x => x.id !== id);
  renderGrid(); updateStats();

  try {
    await supa.delete(id);
    if (m.terabox_path) await tera.deleteFile(m.terabox_path);
    await idbDelete(id);
    showToast('Film supprimé', 'info');
  } catch (e) {
    showToast('Suppression partielle : ' + e.message, 'error');
  }
}

// =====================================================================
// Convert to MP4 — FFmpeg.wasm
// =====================================================================

let ffmpegInstance = null;

async function loadFFmpeg() {
  if (ffmpegInstance) return ffmpegInstance;

  // SharedArrayBuffer requis par FFmpeg.wasm — disponible seulement si la page
  // tourne en contexte cross-origin isolé (COOP + COEP headers via le Service Worker).
  // Le SW s'installe au 1er chargement mais ne contrôle la page qu'après un rechargement.
  if (!self.crossOriginIsolated) {
    throw new Error(
      'FFmpeg nécessite un rechargement de la page. ' +
      'Le Service Worker vient d\'être installé — rechargez la page et réessayez.'
    );
  }

  setProgress(0, 'Chargement de FFmpeg...');
  showToast('⏳ Chargement de FFmpeg (~30 MB, une seule fois)...', 'info');

  const { FFmpeg }    = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js');
  const { toBlobURL } = await import('https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js');

  const ff = new FFmpeg();

  ff.on('progress', ({ progress }) => {
    const pct     = Math.min(99, Math.round(progress * 100));
    const elapsed = (performance.now() - convertStats.startTime) / 1000;
    setProgress(pct, `Conversion : ${pct}%`);
    document.getElementById('stat-elapsed').textContent = formatDuration(elapsed);
    if (pct > 1) {
      document.getElementById('stat-remaining').textContent =
        formatDuration((elapsed / pct) * (100 - pct));
    }
  });

  ff.on('log', ({ message }) => {
    const fpsM  = message.match(/fps=\s*([\d.]+)/);
    if (fpsM && parseFloat(fpsM[1]) > 0)
      document.getElementById('stat-fps').textContent = parseFloat(fpsM[1]).toFixed(0) + ' fps';

    const sizeM = message.match(/size=\s*([\d.]+)\s*[kK][bB]/);
    if (sizeM) {
      const bytes = parseFloat(sizeM[1]) * 1024;
      const now   = performance.now();
      const dt    = (now - convertStats.lastByteTime) / 1000;
      if (dt >= 0.3 && bytes > convertStats.lastBytes) {
        document.getElementById('stat-speed').textContent =
          ((bytes - convertStats.lastBytes) / dt / 1048576).toFixed(2) + ' MB/s';
        convertStats.lastBytes    = bytes;
        convertStats.lastByteTime = now;
      } else if (!convertStats.lastBytes) {
        convertStats.lastBytes = bytes; convertStats.lastByteTime = now;
      }
      convertStats.bytesWritten = bytes;
      document.getElementById('stat-written').textContent = formatSize(bytes);
    }
  });

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
  btn.disabled = false; btn.textContent = 'Convertir en MP4';
  stopStatsTimer(); resetStatsDisplay();
}

function stopStatsTimer() {
  if (convertStats.timerInterval) { clearInterval(convertStats.timerInterval); convertStats.timerInterval = null; }
}

function resetStatsDisplay() {
  ['stat-elapsed','stat-remaining','stat-speed','stat-fps','stat-written'].forEach(id => {
    document.getElementById(id).textContent = id === 'stat-elapsed' ? '0:00' :
      id === 'stat-written' ? '0 MB' : '—';
  });
  document.querySelectorAll('.stat-box').forEach(b => b.classList.remove('active'));
}

function startStatsTimer() {
  convertStats.startTime    = performance.now();
  convertStats.lastByteTime = performance.now();
  convertStats.lastBytes    = 0;
  convertStats.bytesWritten = 0;
  document.querySelectorAll('.stat-box').forEach(b => b.classList.add('active'));
  convertStats.timerInterval = setInterval(() => {
    document.getElementById('stat-elapsed').textContent =
      formatDuration((performance.now() - convertStats.startTime) / 1000);
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
  try { await runFFmpegConversion(); } catch (err) { handleConversionError(err); }
}

async function runFFmpegConversion() {
  const btn = document.getElementById('convertBtn');
  btn.textContent = 'Conversion...';
  const crf     = { high: '18', medium: '23', low: '28' };
  const quality = document.getElementById('qualitySelect').value;
  const { ff }  = await loadFFmpeg();

  startStatsTimer();
  setProgress(1, 'Lecture du fichier source...');

  let sourceData;
  const url = currentMovie.url;
  if (url.startsWith('blob:')) {
    const cached = await idbGet(currentMovie.id);
    sourceData = cached?.blob
      ? await cached.blob.arrayBuffer()
      : await (await fetch(url)).arrayBuffer();
  } else {
    showToast('⬇ Téléchargement depuis Terabox...', 'info');
    sourceData = await (await fetch(url)).arrayBuffer();
  }

  const ext     = currentMovie.ext.toLowerCase();
  const inFile  = `input.${ext}`;
  const outFile = 'output.mp4';

  setProgress(3, 'Écriture dans FFmpeg...');
  await ff.writeFile(inFile, new Uint8Array(sourceData));
  setProgress(5, 'Conversion en cours...');
  btn.textContent = 'Conversion...';

  await ff.exec([
    '-i', inFile, '-c:v', 'libx264',
    '-crf', crf[quality] || '23', '-preset', 'fast',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart', '-y', outFile,
  ]);

  setProgress(98, 'Finalisation...');
  const data    = await ff.readFile(outFile);
  const blob    = new Blob([data.buffer], { type: 'video/mp4' });
  const blobUrl = URL.createObjectURL(blob);
  const outName = currentMovie.title + '_converti.mp4';

  try { await ff.deleteFile(inFile);  } catch {}
  try { await ff.deleteFile(outFile); } catch {}

  stopStatsTimer();
  setProgress(100, 'Conversion terminée !');
  document.getElementById('stat-elapsed').textContent   = formatDuration((performance.now() - convertStats.startTime) / 1000);
  document.getElementById('stat-remaining').textContent = '0:00';
  document.getElementById('stat-written').textContent   = formatSize(blob.size);
  document.getElementById('stat-speed').textContent     = '—';
  document.getElementById('stat-fps').textContent       = '—';

  window._lastConvertedBlob = blob;
  showConvertSuccess(blobUrl, outName, blob.size);
  showToast('✓ Conversion réussie !', 'success');
  btn.textContent = 'Reconvertir'; btn.disabled = false;
}

function setProgress(pct, label) {
  document.getElementById('progressFill').style.width  = pct + '%';
  document.getElementById('progressPct').textContent   = pct + '%';
  document.getElementById('progressLabel').textContent = label;
}

function showConvertSuccess(url, name, size) {
  const div = document.getElementById('convertResult');
  // Stocker l'url et le nom dans des data-attributes pour éviter les bugs
  // avec les apostrophes/guillemets dans les noms de fichiers
  div.style.display = 'block';
  div.innerHTML = `
    <div class="result-success">
      <span class="result-icon">✓</span>
      <span class="result-text">Conversion terminée — <strong>${name.replace(/</g,'&lt;')}</strong> (${formatSize(size)})</span>
      <button class="btn btn-primary"   id="dlConvertedBtn">⬇ Télécharger</button>
      <button class="btn btn-secondary" id="addConvertedBtn">☁ Ajouter & uploader</button>
    </div>`;
  document.getElementById('dlConvertedBtn').onclick  = () => triggerDownload(url, name);
  document.getElementById('addConvertedBtn').onclick = () => addConverted(url, name, size);
}

function handleConversionError(err) {
  stopStatsTimer();
  showToast('Erreur : ' + err.message, 'error');
  const btn = document.getElementById('convertBtn');
  btn.textContent = 'Convertir en MP4'; btn.disabled = false;
  const div = document.getElementById('convertResult');
  div.style.display = 'block';

  // Si le problème vient du Service Worker pas encore actif → proposer rechargement
  const needsReload = err.message.includes('rechargement') || err.message.includes('crossOriginIsolated') || err.message.includes('SharedArrayBuffer');
  div.innerHTML = `
    <div class="result-warning">
      ⚠ Erreur : <em>${err.message}</em><br><br>
      ${needsReload
        ? `<button class="btn btn-blue" onclick="location.reload()" style="width:auto">🔄 Recharger la page</button>&nbsp;`
        : ''}
      <button class="btn btn-secondary" onclick="downloadCurrentMovie()" style="width:auto">⬇ Télécharger l'original</button>
    </div>`;
}

async function addConverted(url, name, size) {
  const blob = window._lastConvertedBlob;
  if (!blob) { showToast('⚠ Fichier introuvable', 'error'); return; }
  await addMovie(new File([blob], name, { type: blob.type }));
}

// =====================================================================
// Toast
// =====================================================================

function showToast(message, type = 'info') {
  const icons     = { success: '✅', error: '❌', info: 'ℹ️' };
  const container = document.getElementById('toastContainer');
  const toast     = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span>${icons[type]}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// =====================================================================
// Exposition globale — nécessaire car app.js est chargé en type="module"
// Les fonctions de module ne sont pas accessibles depuis les onclick HTML
// =====================================================================
window.switchTab            = switchTab;
window.handleFiles          = handleFiles;
window.filterMovies         = filterMovies;
window.openPlayer           = openPlayer;
window.closeModal           = closeModal;
window.downloadCurrentMovie = downloadCurrentMovie;
window.downloadById         = downloadById;
window.triggerDownload      = triggerDownload;
window.deleteMovie          = deleteMovie;
window.convertCurrentMovie  = convertCurrentMovie;
window.addConverted         = addConverted;
