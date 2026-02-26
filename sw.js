/**
 * sw.js — Service Worker
 * Ajoute les headers Cross-Origin requis par FFmpeg.wasm (SharedArrayBuffer)
 * Sans ces headers, FFmpeg.wasm ne peut pas fonctionner.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  e.respondWith(
    fetch(e.request).then(response => {
      // Ne modifier que les réponses HTML et JS
      const type = response.headers.get('content-type') || '';
      if (!type.includes('html') && !type.includes('javascript') && !type.includes('wasm')) {
        return response;
      }

      const newHeaders = new Headers(response.headers);
      newHeaders.set('Cross-Origin-Opener-Policy',   'same-origin');
      newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');
      newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

      return new Response(response.body, {
        status:     response.status,
        statusText: response.statusText,
        headers:    newHeaders,
      });
    })
  );
});
