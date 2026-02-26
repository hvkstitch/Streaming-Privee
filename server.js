/**
 * MaCinémathèque — Terabox Proxy
 * Hébergé gratuitement sur Render.com
 * Relaie les requêtes du navigateur vers l'API Terabox (contourne CORS)
 */

const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

// Ne pas pré-parser le body pour /terabox/upload — il a son propre parser avec grande limite
app.use((req, res, next) => {
  if (req.path === '/terabox/upload') return next();
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === '/terabox/upload') return next();
  express.urlencoded({ extended: true })(req, res, next);
});

// CORS + CORP — nécessaire car la page tourne avec COEP:require-corp (Service Worker FFmpeg)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',   '*');
  res.header('Access-Control-Allow-Methods',  'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers',  'Content-Type, X-Ndus, X-JsToken, X-AppId, X-BrowserId, X-UploadId');
  res.header('Cross-Origin-Resource-Policy',  'cross-origin');  // ← requis par COEP du SW
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Headers communs Terabox
function teraboxHeaders(ndus, browserId) {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept':     'application/json, text/javascript, */*; q=0.01',
    'Referer':    'https://www.terabox.com/disk/home',
    'Origin':     'https://www.terabox.com',
    'Cookie':     `ndus=${ndus}; browserid=${browserId || ''}; lang=en; PANWEB=1`,
  };
}

// Fetch avec timeout configurable (0 = pas de timeout)
function fetchWithTimeout(url, opts = {}, ms = 60000) {
  if (!ms) return fetch(url, opts);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

// ── PRECREATE ─────────────────────────────────────────────────────────
// POST /terabox/precreate
app.post('/terabox/precreate', async (req, res) => {
  const { ndus, jsToken, appId, browserId, path, size, blockList } = req.body;
  try {
    const params = new URLSearchParams({
      channel: 'dubox', web: '1', app_id: appId || '250528',
      clienttype: '0', jsToken,
    });
    const body = new URLSearchParams({
      path, size: String(size), isdir: '0', autoinit: '1', rtype: '1',
      block_list: JSON.stringify(blockList || ['5910a591dd8fc18c32a8f3df4ad24ea8']),
    });
    const r = await fetchWithTimeout(
      `https://www.terabox.com/api/precreate?${params}`,
      { method: 'POST', headers: { ...teraboxHeaders(ndus, browserId), 'Content-Type': 'application/x-www-form-urlencoded' }, body }
    );
    const text = await r.text();
    console.log(`[precreate] status=${r.status} body=${text.slice(0,300)}`);
    try { res.json(JSON.parse(text)); } catch { res.status(502).json({ error: 'Réponse non-JSON', raw: text.slice(0,500) }); }
  } catch (e) {
    console.error('[precreate] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── UPLOAD CHUNK ──────────────────────────────────────────────────────
// POST /terabox/upload — reçoit le chunk en base64
app.post('/terabox/upload', express.json({ limit: '50gb' }), async (req, res) => {
  const { ndus, jsToken, appId, browserId, uploadId, path, partseq, chunkBase64, md5 } = req.body;

  // Validation rapide
  if (!chunkBase64) return res.status(400).json({ error: 'chunkBase64 manquant — body mal parsé ou requête tronquée' });
  if (!uploadId)    return res.status(400).json({ error: 'uploadId manquant' });

  try {
    // Décoder le chunk base64
    const chunkBuffer = Buffer.from(chunkBase64, 'base64');
    console.log(`[upload] partseq=${partseq} chunkSize=${chunkBuffer.length} bytes uploadId=${uploadId}`);

    // Construire le FormData manuellement
    const boundary = '----TeraboxBoundary' + Date.now();
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="blob"\r\nContent-Type: application/octet-stream\r\n\r\n`),
      chunkBuffer,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const params = new URLSearchParams({
      method: 'upload', app_id: appId || '250528',
      channel: 'dubox', clienttype: '0', web: '1',
      jsToken, path, uploadid: uploadId,
      partseq: String(partseq),
    });

    const r = await fetchWithTimeout(
      `https://c-jp.terabox.com/rest/2.0/pcs/superfile2?${params}`,
      {
        method: 'POST',
        headers: {
          ...teraboxHeaders(ndus, browserId),
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': String(body.length),
        },
        body,
      },
      0  // pas de timeout — durée variable selon taille du chunk
    );

    const text = await r.text();
    console.log(`[upload] Terabox response status=${r.status} body=${text.slice(0, 200)}`);
    try {
      res.json(JSON.parse(text));
    } catch {
      res.status(502).json({ error: 'Réponse non-JSON de Terabox', raw: text.slice(0, 500) });
    }
  } catch (e) {
    console.error('[upload] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── CREATE (finalise l'upload) ────────────────────────────────────────
// POST /terabox/create
app.post('/terabox/create', async (req, res) => {
  const { ndus, jsToken, appId, browserId, path, size, uploadId, blockList } = req.body;
  try {
    const params = new URLSearchParams({
      method: 'create', app_id: appId || '250528',
      channel: 'dubox', clienttype: '0', web: '1', jsToken,
    });
    const body = new URLSearchParams({
      path, size: String(size), isdir: '0', rtype: '1',
      uploadid: uploadId,
      block_list: JSON.stringify(blockList),
    });
    const r = await fetchWithTimeout(
      `https://www.terabox.com/api/create?${params}`,
      { method: 'POST', headers: { ...teraboxHeaders(ndus, browserId), 'Content-Type': 'application/x-www-form-urlencoded' }, body }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DOWNLOAD LINK ─────────────────────────────────────────────────────
// GET /terabox/dlink?fsId=xxx&ndus=xxx&jsToken=xxx&appId=xxx
app.get('/terabox/dlink', async (req, res) => {
  const { fsId, ndus, jsToken, appId, browserId } = req.query;
  try {
    const params = new URLSearchParams({
      method: 'filemetas', app_id: appId || '250528',
      web: '1', channel: 'dubox', clienttype: '0',
      jsToken, dlink: '1', fsids: JSON.stringify([parseInt(fsId)]),
    });
    const r = await fetchWithTimeout(
      `https://www.terabox.com/api/filemetas?${params}`,
      { headers: teraboxHeaders(ndus, browserId) }
    );
    const data = await r.json();
    const dlink = data?.list?.[0]?.dlink;
    if (!dlink) return res.status(404).json({ error: 'No dlink found', raw: data });

    // Résoudre la redirection du dlink
    const r2 = await fetchWithTimeout(dlink, {
      headers: teraboxHeaders(ndus, browserId),
      redirect: 'manual',
    });
    const finalUrl = r2.headers.get('location') || dlink;
    res.json({ dlink: finalUrl });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── LIST FILES ────────────────────────────────────────────────────────
// GET /terabox/list?dir=/MaCinematheque&ndus=xxx&jsToken=xxx&appId=xxx
app.get('/terabox/list', async (req, res) => {
  const { dir, ndus, jsToken, appId, browserId } = req.query;
  try {
    const params = new URLSearchParams({
      method: 'list', app_id: appId || '250528',
      web: '1', channel: 'dubox', clienttype: '0',
      jsToken, dir: dir || '/',
      num: '1000', page: '1', order: 'time', desc: '1',
    });
    const r = await fetchWithTimeout(
      `https://www.terabox.com/api/list?${params}`,
      { headers: teraboxHeaders(ndus, browserId) }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE FILES ──────────────────────────────────────────────────────
// POST /terabox/delete
app.post('/terabox/delete', async (req, res) => {
  const { ndus, jsToken, appId, browserId, filelist } = req.body;
  try {
    const params = new URLSearchParams({
      method: 'delete', app_id: appId || '250528',
      web: '1', channel: 'dubox', clienttype: '0', jsToken,
    });
    const body = new URLSearchParams({
      filelist: JSON.stringify(filelist),
      ondup: 'fail', async: '0', onnewver: 'fail',
    });
    const r = await fetchWithTimeout(
      `https://www.terabox.com/api/filemanager?${params}`,
      { method: 'POST', headers: { ...teraboxHeaders(ndus, browserId), 'Content-Type': 'application/x-www-form-urlencoded' }, body }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── MKDIR ─────────────────────────────────────────────────────────────
app.post('/terabox/mkdir', async (req, res) => {
  const { ndus, jsToken, appId, browserId, path } = req.body;
  try {
    const params = new URLSearchParams({
      method: 'create', app_id: appId || '250528',
      web: '1', channel: 'dubox', clienttype: '0', jsToken,
    });
    const body = new URLSearchParams({ path, isdir: '1', rtype: '0' });
    const r = await fetchWithTimeout(
      `https://www.terabox.com/api/create?${params}`,
      { method: 'POST', headers: { ...teraboxHeaders(ndus, browserId), 'Content-Type': 'application/x-www-form-urlencoded' }, body }
    );
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── HEALTH CHECK ──────────────────────────────────────────────────────
app.get('/health', (_, res) => res.json({ ok: true, service: 'MaCinema Terabox Proxy' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
