const CACHE = 'karats-shell-v59';
const ASSETS = ['/', '/app/styles.css', '/app/app.js', '/app/icon.svg', '/manifest.webmanifest', '/Karats-Elite-Plan-Brochure-source.html', '/Karats-Smart-Capital-Calculator.html', '/karats-pdf-libs/html2canvas.min.js', '/karats-pdf-libs/jspdf.umd.min.js', '/fonts/inter-latin-400-normal.woff2', '/fonts/inter-latin-500-normal.woff2', '/fonts/inter-latin-600-normal.woff2', '/fonts/jost-latin-300-normal.woff2', '/fonts/jost-latin-400-normal.woff2', '/fonts/jost-latin-500-normal.woff2', '/fonts/jost-latin-600-normal.woff2', '/fonts/jost-latin-700-normal.woff2', '/fonts/marcellus-latin-400-normal.woff2', '/fonts/cormorant-garamond-latin-400-normal.woff2', '/fonts/cormorant-garamond-latin-400-italic.woff2', '/fonts/cormorant-garamond-latin-600-normal.woff2', '/fonts/cormorant-garamond-latin-700-normal.woff2'];
ASSETS.push('/app/icon-192.png', '/app/icon-512.png', '/app/page-shell.css', '/app/page-shell.js');
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('karats-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || !ASSETS.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(url.pathname, copy))); }
    return response;
  }).catch(async () => (await caches.match(url.pathname)) || Response.error()));
});
