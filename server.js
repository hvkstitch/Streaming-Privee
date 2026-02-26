/**
 * MaCinémathèque — Terabox Proxy v2
 * Le navigateur envoie le fichier en UNE seule requête binaire (FormData)
 * Le serveur gère tout le découpage en chunks vers Terabox
 */

const express = require('express');
const fetch   = require('node-fetch');
const multer  = require('multer');
const crypto  = require('crypto');
const app     = express();

const upload   = multer({ storage: multer.memoryStorage() });
const CHUNK_SIZE = 10 * 1024 * 1024; // 10 MB par chunk côté serveur→Terabox

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function teraboxHeaders(ndus, browserId) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept':     'application/json, text/javascript, */*; q=0.01',
    'Referer':    'https://www.terabox.com/disk/home',
    'Origin':     'https://www.terabox.com',
    'Cookie':     `ndus=${ndus}; browserid=${browserId || ''}; lang=en; PANWEB=1`,
  };
}

async function teraFetch(url, opts = {}) {
  const r = await fetch(url, opts);
  const text = await r.text();
  try { return JSON.parse(text); }
  catch { throw new Error('Non-JSON: ' + text.slice(0, 300)); }
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

// ── UPLOAD COMPLET EN UNE SEULE REQUÊTE ───────────────────────────────
app.post('/terabox/upload-full', upload.single('file'), async (req, res) => {
  const { ndus, jsToken, appId, browserId, remotePath } = req.body;
  const fileBuffer = req.file?.buffer;

  if (!fileBuffer)     return res.status(400).json({ error: 'Fichier manquant' });
  if (!ndus || !jsToken) return res.status(400).json({ error: 'Credentials manquants' });

  const fileSize    = fileBuffer.length;
  const totalChunks = Math.ceil(fileSize / CHUNK_SIZE);
  console.log(`[upload] ${req.file.originalname} — ${fileSize} bytes — ${totalChunks} chunks`);

  try {
    // Précréation
    const preParams = new URLSearchParams({ channel:'dubox', web:'1', app_id: appId||'250528', clienttype:'0', jsToken });
    const preBody   = new URLSearchParams({ path: remotePath, size: String(fileSize), isdir:'0', autoinit:'1', rtype:'1', block_list: JSON.stringify(['5910a591dd8fc18c32a8f3df4ad24ea8']) });
    const pre = await teraFetch(`https://www.terabox.com/api/precreate?${preParams}`, { method:'POST', headers:{...teraboxHeaders(ndus,browserId),'Content-Type':'application/x-www-form-urlencoded'}, body:preBody });
    if (pre.errno && pre.errno !== 0) throw new Error('Precreate errno=' + pre.errno + ' — ' + JSON.stringify(pre));
    const uploadId = pre.uploadid;

    // Upload des chunks (côté serveur, pas de base64, binaire direct)
    const blockList = [];
    for (let i = 0; i < totalChunks; i++) {
      const start    = i * CHUNK_SIZE;
      const chunk    = fileBuffer.slice(start, Math.min(start + CHUNK_SIZE, fileSize));
      const chunkMd5 = md5(chunk);
      blockList.push(chunkMd5);

      const boundary = '----TB' + Date.now();
      const body = Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`),
        chunk,
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const params = new URLSearchParams({ method:'upload', app_id:appId||'250528', channel:'dubox', clienttype:'0', web:'1', jsToken, path:remotePath, uploadid:uploadId, partseq:String(i) });

      let ok = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const up = await teraFetch(`https://c-jp.terabox.com/rest/2.0/pcs/superfile2?${params}`, {
            method:'POST',
            headers:{...teraboxHeaders(ndus,browserId), 'Content-Type':`multipart/form-data; boundary=${boundary}`, 'Content-Length':String(body.length)},
            body,
          });
          if (up.error_code && up.error_code !== 0) throw new Error('error_code=' + up.error_code);
          console.log(`  chunk ${i+1}/${totalChunks} ✓`);
          ok = true; break;
        } catch(e) {
          console.warn(`  chunk ${i+1} tentative ${attempt}/3: ${e.message}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
          else throw new Error(`Chunk ${i+1}/${totalChunks} échoué: ${e.message}`);
        }
      }
    }

    // Finalisation
    const createParams = new URLSearchParams({ method:'create', app_id:appId||'250528', channel:'dubox', clienttype:'0', web:'1', jsToken });
    const createBody   = new URLSearchParams({ path:remotePath, size:String(fileSize), isdir:'0', rtype:'1', uploadid:uploadId, block_list:JSON.stringify(blockList) });
    const create = await teraFetch(`https://www.terabox.com/api/create?${createParams}`, { method:'POST', headers:{...teraboxHeaders(ndus,browserId),'Content-Type':'application/x-www-form-urlencoded'}, body:createBody });
    if (create.errno && create.errno !== 0) throw new Error('Create errno=' + create.errno);

    console.log(`[upload] ✅ fsId=${create.fs_id || create.fsid}`);
    res.json({ ok: true, fsId: create.fs_id || create.fsid, path: remotePath });

  } catch(e) {
    console.error('[upload] ❌', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── DOWNLOAD LINK ──────────────────────────────────────────────────────
app.get('/terabox/dlink', async (req, res) => {
  const { fsId, ndus, jsToken, appId, browserId } = req.query;
  try {
    const params = new URLSearchParams({ method:'filemetas', app_id:appId||'250528', web:'1', channel:'dubox', clienttype:'0', jsToken, dlink:'1', fsids:JSON.stringify([parseInt(fsId)]) });
    const data = await teraFetch(`https://www.terabox.com/api/filemetas?${params}`, { headers:teraboxHeaders(ndus,browserId) });
    const dlink = data?.list?.[0]?.dlink;
    if (!dlink) return res.status(404).json({ error:'No dlink', raw:data });
    const r2 = await fetch(dlink, { headers:teraboxHeaders(ndus,browserId), redirect:'manual' });
    res.json({ dlink: r2.headers.get('location') || dlink });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── LIST ───────────────────────────────────────────────────────────────
app.get('/terabox/list', async (req, res) => {
  const { dir, ndus, jsToken, appId, browserId } = req.query;
  try {
    const params = new URLSearchParams({ method:'list', app_id:appId||'250528', web:'1', channel:'dubox', clienttype:'0', jsToken, dir:dir||'/', num:'1000', page:'1', order:'time', desc:'1' });
    res.json(await teraFetch(`https://www.terabox.com/api/list?${params}`, { headers:teraboxHeaders(ndus,browserId) }));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── DELETE ─────────────────────────────────────────────────────────────
app.post('/terabox/delete', async (req, res) => {
  const { ndus, jsToken, appId, browserId, filelist } = req.body;
  try {
    const params = new URLSearchParams({ method:'delete', app_id:appId||'250528', web:'1', channel:'dubox', clienttype:'0', jsToken });
    const body   = new URLSearchParams({ filelist:JSON.stringify(filelist), ondup:'fail', async:'0', onnewver:'fail' });
    res.json(await teraFetch(`https://www.terabox.com/api/filemanager?${params}`, { method:'POST', headers:{...teraboxHeaders(ndus,browserId),'Content-Type':'application/x-www-form-urlencoded'}, body }));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── MKDIR ──────────────────────────────────────────────────────────────
app.post('/terabox/mkdir', async (req, res) => {
  const { ndus, jsToken, appId, browserId, path } = req.body;
  try {
    const params = new URLSearchParams({ method:'create', app_id:appId||'250528', web:'1', channel:'dubox', clienttype:'0', jsToken });
    const body   = new URLSearchParams({ path, isdir:'1', rtype:'0' });
    res.json(await teraFetch(`https://www.terabox.com/api/create?${params}`, { method:'POST', headers:{...teraboxHeaders(ndus,browserId),'Content-Type':'application/x-www-form-urlencoded'}, body }));
  } catch(e) { res.status(500).json({ error:e.message }); }
});

// ── HEALTH ─────────────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok:true, service:'MaCinema Proxy v2' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy v2 on port ${PORT}`));
