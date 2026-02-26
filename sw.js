/**
 * sw.js — Service Worker v3
 * Ajoute COOP/COEP uniquement sur les réponses same-origin GET (HTML/JS/WASM)
 * NE touche JAMAIS aux requêtes cross-origin ni aux POST/PUT/DELETE
 */

const SW_VERSION = 3;

self.addEventListener('install', () => {
  console.log('[SW] v' + SW_VERSION + ' installing');
  self.skipWaiting(); // prend le contrôle immédiatement
});

self.addEventListener('activate', e => {
  console.log('[SW] v' + SW_VERSION + ' activated');
  e.waitUntil(self.clients.claim()); // contrôle toutes les pages ouvertes
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);

  // ── Règles d'exclusion ──────────────────────────────────────────────
  // 1. Uniquement same-origin (jamais proxy Render, Supabase, Terabox, CDN)
  if (url.origin !== self.location.origin) return;
  // 2. Uniquement GET (jamais POST/PUT/DELETE — notamment les uploads)
  if (req.method !== 'GET') return;
  // 3. Uniquement HTML, JS ou WASM (pas les vidéos, images, etc.)
  const ext = url.pathname.split('.').pop().toLowerCase();
  if (!['html', 'js', 'mjs', 'wasm', ''].includes(ext)) return;

  e.respondWith(
    fetch(req).then(response => {
      const type = response.headers.get('content-type') || '';
      if (!type.includes('html') && !type.includes('javascript') && !type.includes('wasm')) {
        return response;
      }
      const headers = new Headers(response.headers);
      headers.set('Cross-Origin-Opener-Policy',   'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
      return new Response(response.body, {
        status: response.status, statusText: response.statusText, headers,
      });
    })
  );
});
