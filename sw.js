// Guarda la app y el mapa de los viajes para poder usarla sin señal.
const APP = 'camionesar-app-v14';
const MAP = 'camionesar-mapa-v1';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'nube-config.js', 'nube.js', 'vendor/supabase/supabase.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
  'vendor/maplibre/maplibre-gl.js', 'vendor/maplibre/maplibre-gl.css', 'data/restricciones.json', 'data/propias.json'];
self.addEventListener('install', e => e.waitUntil(caches.open(APP).then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {})))).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== APP && k !== MAP).map(k => caches.delete(k)))).then(() => self.clients.claim())));

const isMapAsset = u => /(^|\.)openfreemap\.org$/.test(u.hostname) || u.hostname === 'fonts.gstatic.com' || u.hostname === 'fonts.googleapis.com';
const isTileOrGlyph = u => /\.(pbf|mvt|png|webp|woff2?)$/.test(u.pathname) || /\/fonts\//.test(u.pathname) || /sprite/.test(u.pathname);

self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (u.origin === location.origin) {
    // La app: primero internet (para recibir arreglos); sin señal, lo guardado.
    e.respondWith(fetch(req).then(r => { const c = r.clone(); caches.open(APP).then(x => x.put(req, c)); return r; })
      .catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  if (!isMapAsset(u)) return; // rutas, búsquedas y la nube: siempre a internet
  if (isTileOrGlyph(u)) {
    // Pedacitos de mapa y letras: lo guardado primero (no cambian).
    e.respondWith(caches.open(MAP).then(c => c.match(req).then(hit => hit || fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }))));
  } else {
    // Estilo y descripción del mapa: internet primero; sin señal, lo guardado.
    e.respondWith(caches.open(MAP).then(c => fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => c.match(req))));
  }
});
