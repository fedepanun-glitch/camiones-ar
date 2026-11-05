/* Camiones AR — app para choferes.
   Mapa vectorial (MapLibre + OpenFreeMap), rutas para camión (openrouteservice), navegación con voz,
   alerta de velocidad y "No puedo pasar" para esquivar calles que en la realidad no sirven.
   Con la nube (nube.js) el chofer entra con usuario + PIN, recibe sus viajes, comparte las calles marcadas
   y manda su ubicación al panel del dueño. La clave de rutas queda en el servidor. */
(() => {
  'use strict';
  // openrouteservice ahora vive en api.heigit.org (HeiGIT dejó de usar api.openrouteservice.org)
  const ORS_HOSTS = [['https://api.heigit.org', { directions: '/openrouteservice/v2/directions/driving-hgv/geojson', search: '/pelias/v1/search', reverse: '/pelias/v1/reverse' }],
    ['https://api.openrouteservice.org', { directions: '/v2/directions/driving-hgv/geojson', search: '/geocode/search', reverse: '/geocode/reverse' }]];
  const NUBE = window.Nube && window.Nube.configurada ? window.Nube : null;
  const isUuid = v => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
  const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => String(n).replace('.', ',');
  const cssVar = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const store = {
    get(k, d) { try { const v = localStorage.getItem('camionesar.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('camionesar.' + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } },
  };
  const km = m => m >= 1000 ? `${fmt((m / 1000).toFixed(m >= 10000 ? 0 : 1))} km` : `${Math.max(10, Math.round(m / 10) * 10)} m`;
  const hm = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };
  const clock = s => new Date(Date.now() + s * 1000).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

  // ---------- Configuración ----------
  const CFG = window.CAMIONES_CONFIG || {};
  // Sin nube: la clave se guarda en el celular. Con nube: no se usa (está en el servidor).
  const key = () => NUBE ? '' : (store.get('key', '') || CFG.orsKey || '').trim();
  let speedLimit = store.get('speedLimit', CFG.speedLimit || 80);
  const EXAMPLE_TRUCKS = [
    { id: 't1', name: 'Hi-Way con semi (ejemplo)', h: 4.1, w: 45, l: 20, wd: 2.6, e: 10.5, hz: true },
    { id: 't2', name: 'Tector (ejemplo)', h: 3.6, w: 17, l: 10, wd: 2.6, e: 10, hz: true },
  ];
  let trucks = store.get('trucks', CFG.trucks || EXAMPLE_TRUCKS);
  let truckId = store.get('truckId', trucks[0] && trucks[0].id);
  const truck = () => trucks.find(t => t.id === truckId) || trucks[0];
  let avoids = store.get('avoids', []);   // [{lat, lon, label, at}]
  let favs = store.get('favs', []);       // [{label, lat, lon}]
  let lugares = NUBE ? store.get('lugares', []) : [];   // lugares de la empresa
  let viajes = NUBE ? store.get('viajes', []) : [];     // viajes asignados a este chofer
  let radares = NUBE ? store.get('radares', []) : [];   // fotomultas (id, lat, lon, maxima)
  const nombreLugar = n => String(n || '').replace(/^Viaje · /, '');   // direcciones de un solo viaje
  let viaje = null;                                     // viaje en curso (si se salió desde "Tus viajes")

  // ---------- Restricciones ----------
  const TYPES = {
    P: { name: 'Prohibido camiones', key: 'hgv', color: '--t-p' },
    D: { name: 'Solo con destino', key: 'hgv', color: '--t-a' },
    A: { name: 'Altura máxima', key: 'maxheight', color: '--t-a', unit: 'm' },
    W: { name: 'Peso máximo', key: 'maxweight', color: '--t-w', unit: 't' },
    L: { name: 'Largo máximo', key: 'maxlength', color: '--t-l', unit: 'm' },
    E: { name: 'Peso por eje', key: 'maxaxleload', color: '--t-l', unit: 't' },
    H: { name: 'Cargas peligrosas', key: 'hazmat', color: '--t-h' },
  };
  const RANGE = { A: [1.2, 8], W: [1, 80], L: [3, 40], E: [1, 25] };
  function parseVal(t, v) {
    if (!(t in RANGE)) return null;
    if (typeof v === 'number') return v;
    let s = String(v).trim().toLowerCase();
    const ft = s.match(/^(\d+)\s*'\s*(\d+)?\s*"?$/);
    if (ft) return +((+ft[1]) * 0.3048 + (+(ft[2] || 0)) * 0.0254).toFixed(2);
    s = s.replace(',', '.').replace(/\s*(m|mts|metros|t|tn|ton|toneladas)\.?$/, '');
    return /^\d+(\.\d+)?$/.test(s) ? parseFloat(s) : NaN;
  }
  let rows = [], oficialRows = [];
  function verdict(r) {
    const T = truck();
    if (r.t === 'P') return 'no';
    if (r.t === 'D') return 'warn';
    if (r.t === 'H') return T.hz ? 'no' : 'ok';
    if (r.dubious) return 'dud';
    const lim = { A: T.h, W: T.w, L: T.l, E: T.e }[r.t];
    if (r.num < lim) return 'no';
    if (r.t === 'A' && r.num - lim < 0.2) return 'warn';
    return 'ok';
  }
  const vlabel = r => r.v === 'no' ? 'No pasa' : r.v === 'warn' ? (r.t === 'A' ? 'Al límite' : 'Solo con destino') : r.v === 'dud' ? 'Dato dudoso' : 'Pasa';
  function describe(r) {
    const T = TYPES[r.t];
    if (r.t === 'P') return 'Prohibido para camiones';
    if (r.t === 'D') return 'Camiones solo con destino';
    if (r.t === 'H') return 'Prohibido carga peligrosa';
    if (r.dubious) return `${T.name}: dato mal cargado`;
    return `${T.name} ${fmt(r.num)} ${T.unit}`;
  }
  const TRUCK_SVG = '<svg viewBox="0 0 24 24" fill="#111"><path d="M2 7h11v8H2zM13 10h4l3 3v2h-7zM4 17.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M14 17.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0"/></svg>';
  function signHTML(r) {
    if (r.t === 'P' || r.t === 'D') return `<div class="sign slash" aria-hidden="true">${TRUCK_SVG}</div>`;
    if (r.t === 'H') return '<div class="sign slash" aria-hidden="true" style="font-size:11px">ONU</div>';
    return `<div class="sign" aria-hidden="true">${Number.isFinite(r.num) ? fmt(r.num) : '?'}</div>`;
  }

  // ---------- Mapa ----------
  const map = new maplibregl.Map({
    container: 'map', style: STYLE, center: [-58.6, -34.45], zoom: 10, attributionControl: false, pitchWithRotate: false,
  });
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© colaboradores de OpenStreetMap (ODbL)' }), 'bottom-right');
  // Si el mapa vectorial no carga, usar las teselas clásicas de OpenStreetMap
  const RASTER = { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19 } },
    layers: [{ id: 'osm', type: 'raster', source: 'osm' }] };
  let fellBack = false;
  let styleOk = false;
  map.on('style.load', () => { styleOk = true; });
  const fallback = () => { if (fellBack || styleOk) return; fellBack = true; map.setStyle(RASTER); };
  map.on('error', () => { if (!styleOk) fallback(); });
  setTimeout(fallback, 10000);
  const ready = new Promise(res => { if (map.loaded()) res(); else map.once('load', res); });
  const EMPTY = { type: 'FeatureCollection', features: [] };

  // Capas propias: se agregan cada vez que se carga un estilo (también si se cambia al mapa de respaldo)
  let handlersOn = false;
  function addLayers() {
    if (map.getSource('route')) return;
    map.addSource('lugares', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'lugares', type: 'circle', source: 'lugares', paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 5, 15, 9], 'circle-color': cssVar('--dark'), 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    map.addSource('avoid', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'avoid', type: 'circle', source: 'avoid', paint: { 'circle-radius': 9, 'circle-color': cssVar('--warn'), 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    map.addSource('connector', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'connector', type: 'line', source: 'connector', layout: { 'line-cap': 'round' }, paint: { 'line-color': cssVar('--route'), 'line-width': 5, 'line-dasharray': [0.5, 2] } });
    map.addSource('route', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 12 } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': cssVar('--route'), 'line-width': 7 } });
    map.addSource('reportes', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'reportes', type: 'symbol', source: 'reportes', minzoom: 9, layout: {
      'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.28, 13, 0.45, 17, 0.6] } });
    map.addSource('radares', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'radares', type: 'symbol', source: 'radares', minzoom: 9, layout: {
      'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 9, 0.3, 13, 0.5, 17, 0.7] } });
    map.addSource('restr', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'restr', type: 'symbol', source: 'restr', layout: {
      'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.32, 13, 0.5, 17, 0.75] } });
    tuneStyle();
    if (route) map.getSource('route').setData({ type: 'Feature', geometry: route.geo, properties: {} });
    drawAvoids(); drawLugares(); drawRadares(); if (NUBE) drawReportes(); refreshRestr();
    if (handlersOn) return; handlersOn = true;
    map.on('click', 'lugares', e => { if (mode !== 'home' && mode !== 'results') return; e.preventDefault(); const l = lugares.find(x => x.id === e.features[0].properties.id); if (l) lugarPopup(l); });
    map.on('click', 'restr', e => { e.preventDefault(); const r = rows[e.features[0].properties.i]; restrPopup(r); });
    map.on('click', 'route', e => { if (mode !== 'preview') return; e.preventDefault(); avoidPopup(e.lngLat); });
    for (const l of ['restr', 'route', 'lugares']) {
      map.on('mouseenter', l, () => { map.getCanvas().style.cursor = 'pointer'; });
      map.on('mouseleave', l, () => { map.getCanvas().style.cursor = ''; });
    }
  }
  map.on('style.load', addLayers);
  ready.then(addLayers);

  // Centrar un punto en la parte visible del mapa (arriba de la hoja de abajo en el celular)
  function focusPoint(lon, lat) {
    const desk = matchMedia('(min-width: 820px)').matches;
    map.easeTo({ center: [lon, lat], zoom: 16, padding: desk ? { left: 450, top: 0, right: 0, bottom: 0 } : { bottom: $('sheet').offsetHeight + 20, top: 70, left: 0, right: 0 }, duration: 600 });
  }
  function restrPopup(r) {
    new maplibregl.Popup({ maxWidth: '300px' }).setLngLat([r.lon, r.lat]).setHTML(`<div class="pop">${signHTML(r)}<div>
      <h3>${esc(r.street)}</h3><p><b>${vlabel(r)}</b> · ${describe(r)}</p>
      <p class="m">${esc([r.loc, r.prov].filter(Boolean).join(', '))}</p>
      <p class="m">${r.oficial ? `Fuente: <a href="${esc(r.fuenteUrl)}" target="_blank" rel="noopener">${esc(r.oficial)}</a>${r.nota ? ' · ' + esc(r.nota) : ''}`
        : `<a href="https://www.openstreetmap.org/${r.et}/${r.id}" target="_blank" rel="noopener">Ver en OpenStreetMap</a>`}</p></div></div>`).addTo(map);
  }

  // Restricciones visibles: en vista previa / navegación, las que tocan la ruta; si se pide, todas las que afectan.
  function refreshRestr() {
    if (!map.getSource('restr')) return;
    const all = store.get('showAll', false);
    const nearIds = new Set((route && route.near || []).map(n => n.r));
    const feats = [];
    rows.forEach((r, i) => {
      r.v = verdict(r);
      const affects = r.v === 'no' || r.v === 'warn';
      if (!affects) return;
      if (!all && !nearIds.has(r)) return;
      feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { i, icon: signId(r) } });
    });
    map.getSource('restr').setData({ type: 'FeatureCollection', features: feats });
  }

  // ---------- Pantallas ----------
  let mode = 'home';
  function setMode(m) {
    mode = m; document.body.dataset.mode = m;
    for (const v of ['home', 'results', 'preview', 'loading']) $('v-' + v).hidden = v !== m;
    const nav = m === 'nav';
    $('turn').hidden = !nav; $('navbar').hidden = !nav;
    $('b-camara').hidden = !(nav && NUBE);
    if (!nav) { $('alert').hidden = true; $('b-center').hidden = true; setConnector(null); map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); map.easeTo({ pitch: 0, bearing: 0, duration: 400 }); }
    if (m === 'home') { renderFavs(); restoreTrip(); }
  }
  document.querySelectorAll('[data-back]').forEach(b => b.addEventListener('click', () => { clearRoute(); setMode('home'); }));
  function showErr(msg) { $('err').textContent = msg || ''; $('err').hidden = !msg; }

  // ---------- Camión elegido ----------
  function renderTruckChip() {
    const T = truck();
    $('truck-name').textContent = T ? `${T.name} · ${fmt(T.h)} m` : 'Elegí un camión';
  }
  $('b-truck').addEventListener('click', () => {
    const box = $('pt-list'); box.textContent = '';
    for (const T of trucks) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'item';
      b.innerHTML = `<span class="ico">${T.id === truckId ? '✔' : ''}</span><span><span class="t">${esc(T.name)}</span><br><span class="m">${fmt(T.h)} m alto · ${fmt(T.w)} t · ${fmt(T.l)} m largo${T.hz ? ' · carga peligrosa' : ''}</span></span><span></span>`;
      b.addEventListener('click', () => { truckId = T.id; store.set('truckId', truckId); renderTruckChip(); refreshRestr(); $('pick-truck').close(); if (route && mode === 'preview') makeRoute(route.from, route.to); });
      box.appendChild(b);
    }
    $('pick-truck').showModal();
  });

  // ---------- GPS ----------
  let me = null, meMarker = null, watchId = null, lastFix = null;
  function meEl() {
    const d = document.createElement('div'); d.className = 'me';
    d.innerHTML = '<svg viewBox="0 0 40 64" aria-hidden="true"><rect x="7" y="22" width="26" height="38" rx="4" fill="#eef1f0" stroke="#17201f" stroke-width="2.5"/><rect x="9" y="4" width="22" height="17" rx="5" fill="#1f6feb" stroke="#fff" stroke-width="2.5"/><rect x="12" y="7" width="16" height="5" rx="2" fill="#bfe0ff"/><path d="M20 0l6 4h-12z" fill="#1f6feb"/></svg>';
    return d;
  }
  function onFix(pos) {
    const c = pos.coords, now = Date.now();
    let speed = Number.isFinite(c.speed) && c.speed !== null ? c.speed * 3.6 : null;
    let heading = Number.isFinite(c.heading) && c.heading !== null ? c.heading : null;
    if (lastFix) {
      const d = dist([lastFix.lat, lastFix.lon], [c.latitude, c.longitude]), dt = (now - lastFix.at) / 1000;
      if (speed === null && dt > 0.5 && dt < 30) speed = d / dt * 3.6;
      if (heading === null && d > 8) heading = bearing([lastFix.lat, lastFix.lon], [c.latitude, c.longitude]);
    }
    me = { lat: c.latitude, lon: c.longitude, speed: speed || 0, heading: heading ?? (me && me.heading) ?? 0, at: now };
    lastFix = { lat: me.lat, lon: me.lon, at: now };
    sendPos(c.accuracy); checkCameras(); if (NUBE) checkReportes();
    if (mode === 'nav') navTick(); else setTarget(me.lat, me.lon, me.heading || 0);
  }

  // El camión se desliza entre una lectura del GPS y la siguiente, y en viaje el mapa lo sigue sin saltos.
  const anim = { cur: null, from: null, to: null, t0: 0, dur: 1000, last: 0, raf: 0, follow: true, zoom: 16.5, zoomTo: 16.5 };
  const lerpAngle = (a, b, t) => { const d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; };
  function setTarget(lat, lon, head) {
    const now = performance.now();
    if (!anim.cur) {
      anim.cur = { lat, lon, head };
      meMarker = new maplibregl.Marker({ element: meEl(), rotationAlignment: 'map', pitchAlignment: 'viewport' }).setLngLat([lon, lat]).addTo(map);
    }
    anim.from = { ...anim.cur }; anim.to = { lat, lon, head };
    anim.dur = Math.min(1600, Math.max(400, anim.last ? now - anim.last : 1000)); anim.last = now; anim.t0 = now;
    if (!anim.raf) anim.raf = requestAnimationFrame(frame);
  }
  function frame(now) {
    const t = Math.min(1, (now - anim.t0) / anim.dur), f = anim.from, g = anim.to;
    anim.cur = { lat: f.lat + (g.lat - f.lat) * t, lon: f.lon + (g.lon - f.lon) * t, head: lerpAngle(f.head, g.head, t) };
    meMarker.setLngLat([anim.cur.lon, anim.cur.lat]); meMarker.setRotation(anim.cur.head);
    let again = t < 1;
    if (mode === 'nav' && anim.follow) {
      anim.zoom += (anim.zoomTo - anim.zoom) * 0.04;
      map.jumpTo({ center: [anim.cur.lon, anim.cur.lat], bearing: anim.cur.head, pitch: 55, zoom: anim.zoom });
      again = again || Math.abs(anim.zoomTo - anim.zoom) > 0.01;
    }
    anim.raf = again ? requestAnimationFrame(frame) : 0;
  }
  function startWatch() {
    if (watchId != null || !('geolocation' in navigator)) return;
    watchId = navigator.geolocation.watchPosition(onFix, err => { if (err.code === 1) showErr('El celular no dio permiso de ubicación. Activalo en la configuración del navegador.'); },
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
  }
  function getMe() {
    if (me && Date.now() - me.at < 30000) return Promise.resolve(me);
    return new Promise((ok, fail) => {
      if (!('geolocation' in navigator)) return fail(new Error('Este celular no tiene GPS disponible.'));
      navigator.geolocation.getCurrentPosition(p => { onFix(p); startWatch(); ok(me); },
        e => fail(new Error(e.code === 1 ? 'El celular no dio permiso de ubicación. Activalo para armar la ruta.' : 'No pude saber dónde estás. Probá de nuevo al aire libre.')),
        { enableHighAccuracy: true, timeout: 20000 });
    });
  }
  $('b-locate').addEventListener('click', async () => {
    try { const p = await getMe(); map.easeTo({ center: [p.lon, p.lat], zoom: 15 }); } catch (e) { showErr(e.message); }
  });

  // ---------- Buscar destino ----------
  function needKey() {
    if (NUBE || key()) return false;
    showErr('Falta la clave de rutas. Tocá el menú ☰ (arriba a la izquierda) y pegala en "Clave de rutas".');
    return true;
  }
  // Coordenadas pegadas (de Google Maps, WhatsApp, etc.): "-34.4123, -58.5912" o un link largo que las tenga
  function parseCoords(text) {
    const m = text.match(/(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{1,3}\.\d{3,})/);
    if (!m) return null;
    const lat = +m[1], lon = +m[2];
    return lat < -21 && lat > -56 && lon < -53 && lon > -74 ? { lat, lon } : null;
  }
  // Pide algo al servicio de rutas: por la función del servidor (nube) o directo con la clave del celular.
  async function ors(op, { body, params, elegir, camion } = {}) {
    if (NUBE) {
      // elegir: el servidor pide varios caminos y devuelve el mejor para camión (avenidas, Red de Tránsito Pesado)
      const r = await NUBE.funcion('rutas', { op, body, params, elegir, camion });
      if (r.status === 401) { showLogin(); throw new Error('Tenés que entrar de nuevo con tu usuario y PIN.'); }
      return r;
    }
    let lastErr;
    for (const [host, paths] of ORS_HOSTS) {
      try {
        let res;
        if (op === 'directions') {
          res = await fetch(host + paths.directions, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key() }, body: JSON.stringify(body) });
        } else {
          const u = new URL(host + paths[op]);
          for (const [k, v] of Object.entries(params || {})) u.searchParams.set(k, v);
          u.searchParams.set('api_key', key());
          res = await fetch(u);
        }
        const data = await res.json().catch(() => ({}));
        if (res.status === 401 || res.status === 403) data.error = { ...(typeof data.error === 'object' ? data.error : {}), code: 'clave', message: 'La clave de rutas no es válida. Revisala en el menú ☰.' };
        return { ok: res.ok, status: res.status, data };
      } catch (e) { lastErr = e; } // sin respuesta de este servidor: probar el siguiente
    }
    throw lastErr;
  }
  async function photon(text, c) {
    const u = `https://photon.komoot.io/api/?q=${encodeURIComponent(text)}&limit=8&lat=${c.lat}&lon=${c.lng}&bbox=-73.6,-55.1,-53.6,-21.7`;
    const d = await (await fetch(u)).json();
    return d.features.filter(f => (f.properties.countrycode || 'AR') === 'AR').map(f => {
      const p = f.properties, addr = [p.street, p.housenumber].filter(Boolean).join(' ');
      const main = p.name || addr || p.city || '';
      const sub = [p.name ? addr : '', p.city || p.district || p.county, p.state].filter(Boolean).join(', ');
      return { label: sub ? `${main}, ${sub}` : main, lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], hn: !!p.housenumber, poi: !!p.name && p.osm_key !== 'highway' && p.osm_key !== 'place' };
    }).filter(x => x.label);
  }
  async function orsSearch(text, c) {
    const res = await ors('search', { params: { text, 'boundary.country': 'AR', size: 6, 'focus.point.lat': c.lat, 'focus.point.lon': c.lng } });
    if (!res.ok) throw new Error(res.data.error && res.data.error.code === 'clave' ? res.data.error.message : 'El buscador no respondió.');
    const d = res.data;
    return d.features.map(f => ({ label: f.properties.label.replace(/, Argentina$/, ''), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], hn: !!f.properties.housenumber }));
  }
  async function geocode(text) {
    if (/goo\.gl|maps\.app/i.test(text)) throw new Error('Ese link de Google Maps es corto y no trae la ubicación. En Google Maps dejá el dedo apretado sobre el lugar, copiá los números que aparecen arriba (por ejemplo -34.41, -58.59) y pegalos acá.');
    const xy = parseCoords(text);
    if (xy) return [{ label: 'Ubicación pegada', ...xy }];
    const c = me ? { lat: me.lat, lng: me.lon } : map.getCenter();
    const [a, b] = await Promise.allSettled([photon(text, c), orsSearch(text, c)]);
    if (a.status === 'rejected' && b.status === 'rejected' && !(NUBE && lugaresQueCoinciden(text).length)) throw b.reason;
    const out = [];
    for (const r of [...(NUBE ? lugaresQueCoinciden(text) : []), ...(a.value || []), ...(b.value || [])]) {
      if (out.some(o => dist([o.lat, o.lon], [r.lat, r.lon]) < 60)) continue;
      out.push(r);
    }
    const wantsNumber = /\d/.test(text) && !xy;
    return out.slice(0, 8).map(r => ({ ...r, label: wantsNumber && !r.hn && !r.poi ? r.label + ' (sin altura exacta)' : r.label }));
  }
  async function reverse(lat, lon) {
    try {
      const d = (await ors('reverse', { params: { 'point.lat': lat, 'point.lon': lon, size: 1, 'boundary.country': 'AR' } })).data;
      return d.features[0].properties.label.replace(/, Argentina$/, '');
    } catch (e) { return 'Punto en el mapa'; }
  }
  $('f-search').addEventListener('submit', async e => {
    e.preventDefault(); showErr('');
    const text = $('q').value.trim();
    if (text.length < 3 || needKey()) return;
    $('q').blur();
    setMode('loading'); $('loading-text').textContent = 'Buscando…';
    try {
      const res = await geocode(text);
      const box = $('results'); box.textContent = '';
      if (!res.length) { setMode('home'); showErr('No encontré ese lugar. Probá con calle, número y ciudad.'); return; }
      for (const p of res) {
        const [first, ...rest] = p.label.split(', ');
        const b = document.createElement('button'); b.type = 'button'; b.className = 'item';
        b.innerHTML = `<span class="ico">${p.own ? '🏠' : '📍'}</span><span><span class="t">${esc(first)}</span><br><span class="m">${esc(rest.join(', '))}</span></span><span></span>`;
        b.addEventListener('click', () => goTo(p));
        box.appendChild(b);
      }
      setMode('results');
    } catch (err) { setMode('home'); showErr(err.message); }
  });

  function renderFavs() {
    const box = $('favs'); box.textContent = '';
    renderCloudLists(box);
    if (NUBE && favs.length) { const h = document.createElement('h3'); h.className = 'list-title'; h.textContent = 'Guardados'; box.appendChild(h); }
    for (const [i, f] of favs.entries()) {
      const b = document.createElement('div'); b.className = 'item'; b.setAttribute('role', 'button'); b.tabIndex = 0;
      b.innerHTML = `<span class="ico">★</span><span><span class="t">${esc(f.label.split(', ')[0])}</span><br><span class="m">${esc(f.label.split(', ').slice(1).join(', '))}</span></span><button type="button" class="x" aria-label="Borrar">✕</button>`;
      b.addEventListener('click', ev => { if (ev.target.closest('.x')) { favs.splice(i, 1); store.set('favs', favs); renderFavs(); return; } goTo(f); });
      b.addEventListener('keydown', ev => { if (ev.key === 'Enter') goTo(f); });
      box.appendChild(b);
    }
  }

  // Tocar el mapa para elegir destino
  map.on('click', e => {
    if (e.defaultPrevented || (mode !== 'home' && mode !== 'results')) return;
    const div = document.createElement('div');
    div.innerHTML = '<div class="pop-actions"><button type="button" class="big go">Ir acá</button></div>';
    const pop = new maplibregl.Popup({ closeButton: true }).setLngLat(e.lngLat).setDOMContent(div).addTo(map);
    div.querySelector('button').addEventListener('click', async () => {
      pop.remove();
      if (needKey()) return;
      goTo({ label: await reverse(e.lngLat.lat, e.lngLat.lng), lat: e.lngLat.lat, lon: e.lngLat.lng });
    });
  });

  // ---------- Ruta ----------
  let route = null, destMarker = null;
  function dist(a, b) {
    const R = 6371000, r = Math.PI / 180, x = (b[1] - a[1]) * r * Math.cos((a[0] + b[0]) / 2 * r), y = (b[0] - a[0]) * r;
    return Math.sqrt(x * x + y * y) * R;
  }
  function bearing(a, b) {
    const r = Math.PI / 180, y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
    const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
    return (Math.atan2(y, x) / r + 360) % 360;
  }
  function distToSeg(p, a, b) {
    const k = Math.cos(p[0] * Math.PI / 180) * 111320, m = 110540;
    const ax = (a[1] - p[1]) * k, ay = (a[0] - p[0]) * m, bx = (b[1] - p[1]) * k, by = (b[0] - p[0]) * m;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return { d: Math.sqrt(x * x + y * y), t };
  }

  function avoidPoints() {
    const own = (window.__OWN || []).filter(o => o.lat !== '' && o.lat != null && Number.isFinite(+o.lat) && Number.isFinite(+o.lon));
    // cortes reportados por los choferes y puentes más bajos que el camión
    const T = truck();
    const rep = NUBE ? reportes.filter(r => r.tipo === 'corte' || (r.tipo === 'altura' && r.dato && T && T.h >= r.dato - 0.1)).map(r => ({ lat: r.lat, lon: r.lon })) : [];
    // restricciones oficiales (p. ej. puentes con límite de peso de Vialidad) que este camión no cumple
    const ofi = rows.filter(r => r.oficial && verdict(r) === 'no').map(r => ({ lat: r.lat, lon: r.lon }));
    return avoids.concat(own.map(o => ({ lat: +o.lat, lon: +o.lon })), rep, ofi);
  }
  function polygonsFor(pts) {
    if (!pts.length) return null;
    return { type: 'MultiPolygon', coordinates: pts.map(({ lat, lon }) => {
      const dy = 0.00035, dx = 0.00035 / Math.cos(lat * Math.PI / 180);
      return [[[lon - dx, lat - dy], [lon + dx, lat - dy], [lon + dx, lat + dy], [lon - dx, lat + dy], [lon - dx, lat - dy]]];
    }) };
  }

  // Indicaciones en criollo, armadas a partir del tipo de maniobra
  const MANEUVER = {
    0: 'Doblá a la izquierda', 1: 'Doblá a la derecha', 2: 'Doblá cerrado a la izquierda', 3: 'Doblá cerrado a la derecha',
    4: 'Tomá levemente a la izquierda', 5: 'Tomá levemente a la derecha', 6: 'Seguí derecho', 7: 'En la rotonda', 8: 'Salí de la rotonda',
    9: 'Pegá la vuelta', 10: 'Llegaste a destino', 11: 'Arrancá', 12: 'Mantenete a la izquierda', 13: 'Mantenete a la derecha',
  };
  function say(step) {
    const n = step.name && step.name !== '-' ? step.name.split(',')[0] : '';
    if (step.type === 7) return `En la rotonda, tomá la ${step.exit_number || ''}ª salida${n ? ' hacia ' + n : ''}`.replace(' ª', '');
    if (step.type === 10) return 'Llegaste a destino';
    if (step.type === 11) return n ? `Arrancá por ${n}` : 'Arrancá';
    return MANEUVER[step.type] ? `${MANEUVER[step.type]}${n ? (step.type === 6 ? ' por ' : ' en ') + n : ''}` : step.instruction;
  }
  function arrowSVG(type) {
    const rot = { 0: -90, 1: 90, 2: -135, 3: 135, 4: -40, 5: 40, 6: 0, 12: -20, 13: 20, 9: 180 }[type];
    if (type === 7 || type === 8) return '<svg viewBox="0 0 72 72"><circle cx="36" cy="40" r="14" fill="none" stroke="#fff" stroke-width="7"/><path d="M36 26V6M26 16l10-10 10 10" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    if (type === 10) return '<svg viewBox="0 0 72 72"><path d="M20 64V8M20 10h34l-8 12 8 12H20" fill="none" stroke="#fff" stroke-width="6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    return `<svg viewBox="0 0 72 72"><g transform="rotate(${rot || 0} 36 36)"><path d="M36 64V14M18 30l18-18 18 18" fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></g></svg>`;
  }

  // Pide un tramo al servicio de rutas. Devuelve coords [lat, lon], pasos, distancia y tiempo.
  async function rawRoute(from, to, pts) {
    const T = truck();
    const body = {
      coordinates: [[from.lon, from.lat], [to.lon, to.lat]], language: 'es', instructions: true, units: 'm', radiuses: [2000, 2000],
      options: { vehicle_type: 'hgv', profile_params: { restrictions: { height: T.h, weight: T.w, length: T.l, width: T.wd, axleload: T.e, hazmat: !!T.hz } } },
    };
    const av = polygonsFor(pts || []); if (av) body.options.avoid_polygons = av;
    const res = await ors('directions', { body, elegir: true, camion: { largo: T.l, peso: T.w } });
    const d = res.data || {};
    if (!res.ok) {
      const code = d.error && d.error.code;
      const e = new Error('El servicio de rutas no respondió. Probá de nuevo en un rato.'); e.code = code;
      if (code === 'clave') e.message = d.error.message;
      else if (code === 2004) e.message = 'too-long';
      else if (code === 2010) e.message = 'No hay una calle para camión cerca del punto de salida o de llegada.';
      else if (code === 2009 || code === 2099) e.message = 'No encontré una ruta posible para este camión. Probá con otro destino o revisá las calles evitadas.';
      else if (res.status === 429) e.message = 'Se alcanzó el límite de rutas gratis de hoy. Probá de nuevo mañana.';
      throw e;
    }
    const f = d.features[0];
    return { coords: f.geometry.coordinates.map(([lo, la]) => [la, lo]), steps: f.properties.segments.flatMap(s => s.steps),
      dist: f.properties.summary.distance || 0, dur: f.properties.summary.duration || 0, eleccion: f.properties.eleccion || null, zonas: f.properties.zonas || null };
  }
  const cumOf = coords => { const c = [0]; for (let i = 1; i < coords.length; i++) c.push(c[i - 1] + dist(coords[i - 1], coords[i])); return c; };

  // Une tramos: el servicio gratis solo esquiva calles en rutas de hasta 150 km,
  // así que en viajes largos se esquiva en una ventana alrededor de cada punto y el resto usa la ruta normal.
  function slice(base, i0, i1) {
    const coords = base.coords.slice(i0, i1 + 1);
    const steps = base.steps.filter(s => s.way_points[0] >= i0 && s.way_points[0] < i1)
      .map(s => ({ ...s, way_points: [s.way_points[0] - i0, Math.min(s.way_points[1], i1) - i0] }));
    const dur = steps.reduce((a, s) => a + (s.duration || 0), 0);
    return { coords, steps, dist: base.cum[i1] - base.cum[i0], dur };
  }
  function join(pieces) {
    const coords = [], steps = []; let dist0 = 0, dur = 0;
    pieces.forEach((p, k) => {
      const off = coords.length ? coords.length - 1 : 0;
      coords.push(...(coords.length ? p.coords.slice(1) : p.coords));
      for (const s of p.steps) {
        if (s.type === 11 && k > 0) continue;
        if (s.type === 10 && k < pieces.length - 1) continue;
        steps.push({ ...s, way_points: [s.way_points[0] + off, s.way_points[1] + off] });
      }
      dist0 += p.dist; dur += p.dur;
    });
    return { coords, steps, dist: dist0, dur };
  }
  async function stitched(from, to, pts) {
    const base = await rawRoute(from, to, null);
    base.cum = cumOf(base.coords);
    const W = 25000, total = base.cum[base.cum.length - 1];
    const wins = [];
    for (const q of pts) {
      let best = Infinity, bi = 0;
      for (let i = 0; i < base.coords.length; i += 1) { const d = dist(base.coords[i], [q.lat, q.lon]); if (d < best) { best = d; bi = i; } }
      if (best > 3000) continue;              // lejos de esta ruta: no molesta
      wins.push([Math.max(0, base.cum[bi] - W), Math.min(total, base.cum[bi] + W)]);
    }
    if (!wins.length) return base;
    wins.sort((a, b) => a[0] - b[0]);
    const merged = [wins[0]];
    for (const w of wins.slice(1)) { const m = merged[merged.length - 1]; if (w[0] <= m[1] && w[1] - m[0] < 140000) m[1] = Math.max(m[1], w[1]); else merged.push(w); }
    const idxAt = m => { let i = 0; while (i < base.cum.length - 1 && base.cum[i] < m) i++; return i; };
    const pieces = []; let cur = 0;
    for (const [a, b] of merged) {
      const i0 = idxAt(a), i1 = idxAt(b);
      if (i0 > cur) pieces.push(slice(base, cur, i0));
      const pFrom = i0 === 0 ? from : { lat: base.coords[i0][0], lon: base.coords[i0][1] };
      const pTo = i1 >= base.coords.length - 1 ? to : { lat: base.coords[i1][0], lon: base.coords[i1][1] };
      pieces.push(await rawRoute(pFrom, pTo, pts));
      cur = i1;
    }
    if (cur < base.coords.length - 1) pieces.push(slice(base, cur, base.coords.length - 1));
    return join(pieces);
  }

  async function requestRoute(from, to) {
    const pts = avoidPoints();
    let r;
    try { r = await rawRoute(from, to, pts); }
    catch (e) { if (e.message !== 'too-long') throw e; r = await stitched(from, to, pts); }
    const cum = cumOf(r.coords);
    const steps = r.steps.map(s => ({ ...s, text: say(s) }));
    const rt = { from, to, coords: r.coords, cum, steps, total: cum[cum.length - 1], time: r.dur, eleccion: r.eleccion || null, zonas: r.zonas || null,
      geo: { type: 'LineString', coordinates: r.coords.map(([la, lo]) => [lo, la]) } };
    rt.near = nearRoute(rt, 25);
    return rt;
  }

  function nearRoute(rt, maxM) {
    let a = 90, b = -90, c = 180, e = -180;
    for (const [la, lo] of rt.coords) { a = Math.min(a, la); b = Math.max(b, la); c = Math.min(c, lo); e = Math.max(e, lo); }
    const out = [];
    for (const r of rows) {
      r.v = verdict(r);
      if (r.v !== 'no' && r.v !== 'warn') continue;
      if (r.lat < a - .002 || r.lat > b + .002 || r.lon < c - .002 || r.lon > e + .002) continue;
      let best = Infinity, at = 0;
      for (let i = 1; i < rt.coords.length; i++) {
        const s = distToSeg([r.lat, r.lon], rt.coords[i - 1], rt.coords[i]);
        if (s.d < best) { best = s.d; at = rt.cum[i - 1] + s.t * (rt.cum[i] - rt.cum[i - 1]); }
      }
      if (best <= maxM) out.push({ r, at });
    }
    return out.sort((x, y) => x.at - y.at);
  }

  function drawRoute(rt) {
    ready.then(() => { const src = map.getSource('route'); if (src) src.setData(rt ? { type: 'Feature', geometry: rt.geo, properties: {} } : EMPTY); });
    if (destMarker) { destMarker.remove(); destMarker = null; }
    if (rt) { const el = document.createElement('div'); el.className = 'pin'; destMarker = new maplibregl.Marker({ element: el }).setLngLat([rt.to.lon, rt.to.lat]).addTo(map); }
    refreshRestr();
  }
  function clearRoute() { route = null; drawRoute(null); }
  function setConnector(line) {
    const src = map.getSource && map.getSource('connector');
    if (src) src.setData(line ? { type: 'Feature', geometry: { type: 'LineString', coordinates: line }, properties: {} } : EMPTY);
  }
  // Si el chofer mueve el mapa con el dedo, se deja de seguir al camión hasta que toque "Centrar"
  map.on('dragstart', () => { if (mode === 'nav') { anim.follow = false; $('b-center').hidden = false; } });
  $('b-center').addEventListener('click', () => { anim.follow = true; $('b-center').hidden = true; if (!anim.raf) anim.raf = requestAnimationFrame(frame); });

  async function goTo(place, keepTrip) {
    if (!keepTrip) viaje = null;
    showErr('');
    if (needKey()) return;
    setMode('loading'); $('loading-text').textContent = 'Armando la ruta para tu camión…';
    try {
      const p = await getMe();
      await makeRoute({ lat: p.lat, lon: p.lon }, place);
    } catch (err) { setMode('home'); showErr(err.message); }
  }
  async function makeRoute(from, to) {
    route = await requestRoute(from, to);
    drawRoute(route);
    $('dest-name').textContent = to.label;
    $('p-km').textContent = km(route.total);
    $('p-time').textContent = hm(route.time);
    // Por qué se eligió este camino (avenidas y Red de Tránsito Pesado)
    const el = route.eleccion;
    $('p-eleccion').hidden = !el;
    if (el) $('p-eleccion').textContent = `🚛 Camino para camión: ${Math.round((1 - el.calles) * 100)}% por rutas y avenidas` +
      (el.enRed != null && el.kmEnZona >= 0.5 ? ` · en ciudad, ${Math.round(el.enRed * 100)}% por la red oficial de tránsito pesado` : '') +
      (el.opciones > 1 ? ' (elegido entre ' + el.opciones + ' caminos)' : '');
    // Bitrén entrando a Capital: solo corredores autorizados (Ley 6675 de CABA)
    const T = truck();
    const kmCaba = el ? (el.kmEnCaba ?? el.kmEnZona) : 0;
    $('p-bitren').hidden = !(el && T && T.l >= 22.4 && kmCaba >= 0.3);
    if (!$('p-bitren').hidden) $('p-bitren').textContent = `⚠️ Bitrén en Capital: por ley (Ley 6675, art. 9.10.6) un bitrén solo puede circular por los corredores autorizados hacia el Puerto o el Centro de Transferencia de Cargas (Gral. Paz calzada pesada, Lugones, Illia, Paseo del Bajo, AU 25 de Mayo, Perito Moreno, Dellepiane, Cámpora, Coronel Roca, Pergamino, 27 de Febrero). Esta ruta pasa ${fmt(kmCaba)} km por Capital: revisala antes de salir.`;
    // Zonas prohibidas por ordenanza (p. ej. Rosario para semirremolques y acoplados)
    const zn = route.zonas;
    const zt = [];
    if (zn && zn.dentro && zn.dentro.length) zt.push(...zn.dentro.map(z => `⛔ El viaje empieza o termina dentro de una zona prohibida para este camión: ${z.nombre}.${z.nota ? ' ' + z.nota : ''}${z.fuente ? ' (' + z.fuente + ')' : ''}`));
    if (zn && zn.evitadas && zn.evitadas.length) zt.push(`✅ Se esquiva: ${zn.evitadas.join(', ')}.`);
    $('p-zonas').hidden = !zt.length;
    $('p-zonas').textContent = zt.join(' ');
    const n = route.near.length;
    $('b-checks').hidden = !n;
    $('b-checks').textContent = n ? `⚠ ${n === 1 ? '1 lugar' : n + ' lugares'} para mirar en el camino` : '';
    $('checks').hidden = true;
    const box = $('checks'); box.textContent = '';
    for (const x of route.near.slice(0, 12)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'item';
      b.innerHTML = `${signHTML(x.r)}<span><span class="t">${esc(x.r.street)}</span><br><span class="m">${vlabel(x.r)} · ${describe(x.r)} · a ${km(x.at)}</span></span><span></span>`;
      b.addEventListener('click', () => { focusPoint(x.r.lon, x.r.lat); restrPopup(x.r); });
      box.appendChild(b);
    }
    setMode('preview');
    const lons = route.coords.map(c => c[1]), lats = route.coords.map(c => c[0]);
    const desktop = matchMedia('(min-width: 820px)').matches;
    map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: desktop ? { top: 80, bottom: 40, left: 460, right: 40 } : { top: 80, bottom: Math.round(innerHeight * 0.55), left: 30, right: 30 }, duration: 600 });
  }
  $('b-checks').addEventListener('click', () => { $('checks').hidden = !$('checks').hidden; });
  $('b-fav').addEventListener('click', () => {
    if (!route) return;
    if (!favs.some(f => f.label === route.to.label)) { favs.unshift({ label: route.to.label, lat: route.to.lat, lon: route.to.lon }); store.set('favs', favs.slice(0, 12)); }
    $('b-fav').textContent = '★ Guardado';
  });

  // Evitar un punto de la ruta (vista previa)
  function avoidPopup(lngLat) {
    const div = document.createElement('div');
    div.innerHTML = '<p style="margin:0 0 6px">¿Por acá no puede pasar un camión?</p><div class="pop-actions"><button type="button" class="big warn">Evitar y recalcular</button></div>';
    const pop = new maplibregl.Popup().setLngLat(lngLat).setDOMContent(div).addTo(map);
    div.querySelector('button').addEventListener('click', async () => {
      pop.remove();
      addAvoid(lngLat.lat, lngLat.lng, 'Marcado en la ruta');
      setMode('loading'); $('loading-text').textContent = 'Buscando otro camino…';
      try { await makeRoute(route.from, route.to); } catch (e) { setMode('preview'); showErr(e.message); }
    });
  }
  function addAvoid(lat, lon, label) {
    avoids.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), label, at: new Date().toISOString().slice(0, 10), mine: true, pending: !!NUBE });
    store.set('avoids', avoids); drawAvoids();
    if (NUBE) flushAvoids();
  }
  // Con nube: las calles marcadas se suben y las ven todos los choferes. Sin señal quedan en espera.
  let flushing = false;
  async function flushAvoids() {
    if (!NUBE || flushing || !session) return;
    flushing = true;
    try {
      for (const a of avoids.filter(x => x.pending)) {
        const { data, error } = await NUBE.sb.from('bloqueos').insert({ lat: a.lat, lon: a.lon, calle: a.label, creado_por: session.user.id }).select('id').single();
        if (error) break;
        a.id = data.id; a.pending = false;
      }
      store.set('avoids', avoids);
    } finally { flushing = false; }
  }
  function drawAvoids() {
    if (!map.getSource('avoid')) return;
    map.getSource('avoid').setData({ type: 'FeatureCollection', features: avoids.map(a => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [a.lon, a.lat] }, properties: {} })) });
  }

  // ---------- Navegación ----------
  const nav = { idx: 0, spoken: {}, off: 0, lastReroute: 0, wake: null, overSince: 0, lastSpeedWarn: 0, audio: null };
  function speak(text) {
    try { if (!('speechSynthesis' in window)) return; const u = new SpeechSynthesisUtterance(text); u.lang = 'es-AR'; u.rate = 1; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* sin voz */ }
  }
  function beep() {
    try {
      const a = nav.audio || (nav.audio = new (window.AudioContext || window.webkitAudioContext)());
      for (const [t, f] of [[0, 880], [0.25, 880], [0.5, 1100]]) {
        const o = a.createOscillator(), g = a.createGain(); o.frequency.value = f; o.type = 'square';
        g.gain.setValueAtTime(0.25, a.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, a.currentTime + t + 0.2);
        o.connect(g).connect(a.destination); o.start(a.currentTime + t); o.stop(a.currentTime + t + 0.2);
      }
    } catch (e) { /* sin sonido */ }
  }
  function requestWake() {
    try { navigator.wakeLock.request('screen').then(w => { nav.wake = w; w.addEventListener('release', () => { nav.wake = null; }); }).catch(() => {}); } catch (e) { /* sin soporte */ }
  }
  document.addEventListener('visibilitychange', () => { if (mode === 'nav' && document.visibilityState === 'visible' && !nav.wake) requestWake(); });

  $('b-go').addEventListener('click', async () => {
    if (!route) return;
    try { await getMe(); } catch (e) { showErr(e.message); return; }
    try { nav.audio = nav.audio || new (window.AudioContext || window.webkitAudioContext)(); nav.audio.resume(); } catch (e) { /* nada */ }
    Object.assign(nav, { idx: 0, spoken: {}, off: 0, overSince: 0, joined: false });
    anim.follow = true; $('b-center').hidden = true;
    setMode('nav'); requestWake(); startWatch();
    map.setPadding({ top: Math.round(innerHeight * 0.42), bottom: 100, left: 0, right: 0 });
    saveTrip(); downloadCorridor(route);
    if (viaje && viaje.estado === 'pendiente') setTripState(viaje, 'en_curso');
    lastPos.at = 0; sendPos(); shareRoute(route);
    speak('Vamos. ' + (route.steps[0] ? route.steps[0].text : ''));
    navTick();
  });
  function stopNav(terminado) {
    try { nav.wake && nav.wake.release(); } catch (e) { /* nada */ }
    try { speechSynthesis.cancel(); } catch (e) { /* nada */ }
    store.set('trip', null);
    if (NUBE) closeEpisode(true);     // si venía pasado de velocidad, se cierra ese tramo
    if (viaje && terminado) setTripState(viaje, 'terminado');
    viaje = null; shareRoute(null);
    clearRoute(); setMode('home');
  }
  $('b-stop').addEventListener('click', () => {
    // Cerca del destino: terminado. Lejos y con un viaje asignado: se pregunta (puede haber cambiado algo)
    const cerca = route && me && dist([me.lat, me.lon], [route.to.lat, route.to.lon]) < 300;
    if (!viaje || cerca) { stopNav(!!viaje); return; }
    $('et-dest').textContent = `Viaje a ${route ? route.to.label : 'destino'}. Si el viaje cambió o no se hace, avisale también al dueño.`;
    $('end-trip').returnValue = '';
    $('end-trip').showModal();
  });
  $('end-trip').addEventListener('close', () => {
    const r = $('end-trip').returnValue;
    if (r === 'fin') { stopNav(true); speak('Viaje terminado.'); }
    else if (r === 'pausa') stopNav(false);       // queda "en curso" para seguirlo después
  });

  // "No puedo pasar": evita la próxima maniobra y recalcula desde donde está el camión
  $('b-cant').addEventListener('click', async () => {
    if (!route || !me) return;
    const done = route.cum[nav.idx] || 0;
    let si = route.steps.findIndex(s => route.cum[s.way_points[0]] > done + 5);
    const step = route.steps[si >= 0 ? si : route.steps.length - 1];
    const toStep = route.cum[step.way_points[0]] - done;
    // si la maniobra está lejos, evitar el tramo que tiene adelante (unos 60 m)
    let p = route.coords[step.way_points[0]];
    if (toStep > 300) { let i = nav.idx; while (i < route.coords.length - 1 && route.cum[i] - done < 60) i++; p = route.coords[i]; }
    addAvoid(p[0], p[1], step.name && step.name !== '-' ? step.name : 'Calle sin nombre');
    showAlert('Buscando otro camino…', 'orange');
    speak('Entendido. Busco otro camino.');
    await reroute(true);
  });

  async function reroute(force) {
    if (!force && Date.now() - nav.lastReroute < 30000) return;
    nav.lastReroute = Date.now();
    try {
      const rt = await requestRoute({ lat: me.lat, lon: me.lon }, route.to);
      route = rt; drawRoute(rt);
      Object.assign(nav, { idx: 0, spoken: {}, off: 0, joined: false });
      hideAlert(); navTick(); saveTrip(); downloadCorridor(rt); shareRoute(rt);
    } catch (e) {
      if (!navigator.onLine || /fetch|network/i.test(e.message)) { nav.lastReroute = Date.now() - 20000; showAlert('Sin señal: volvé a la línea azul. Recalculo cuando vuelva la señal.', 'orange'); }
      else showAlert(e.message, 'orange');
    }
  }

  let alertTimer;
  function showAlert(text, cls) { const a = $('alert'); a.textContent = text; a.className = 'alert-banner' + (cls ? ' ' + cls : ''); a.hidden = false; clearTimeout(alertTimer); alertTimer = setTimeout(hideAlert, 6000); }
  function hideAlert() { $('alert').hidden = true; }

  function checkSpeed() {
    const v = Math.round(me.speed || 0);
    $('speed-n').textContent = v;
    const over = v > speedLimit;
    $('speed').classList.toggle('over', over);
    if (!over) { nav.overSince = 0; speedEpisode(v, false); return; }
    if (!nav.overSince) nav.overSince = Date.now();
    if (Date.now() - nav.overSince > 3000) speedEpisode(v, true);   // al dueño le llega una alerta por tramo
    if (Date.now() - nav.overSince > 3000 && Date.now() - nav.lastSpeedWarn > 20000) {
      nav.lastSpeedWarn = Date.now();
      beep(); showAlert(`¡Bajá la velocidad! Máximo ${speedLimit} km/h`);
      setTimeout(() => speak(`Bajá la velocidad. Vas a ${v}. El máximo es ${speedLimit}.`), 800);
    }
  }

  function navTick() {
    if (mode !== 'nav' || !me || !route) return;
    checkSpeed();
    const p = [me.lat, me.lon], c = route.coords;
    let best = Infinity, bi = nav.idx, bt = 0;
    for (let i = Math.max(1, nav.idx - 20); i <= Math.min(c.length - 1, nav.idx + 400); i++) {
      const s = distToSeg(p, c[i - 1], c[i]); if (s.d < best) { best = s.d; bi = i - 1; bt = s.t; }
    }
    nav.idx = bi;
    const done = route.cum[bi] + bt * (route.cum[bi + 1] - route.cum[bi]);
    const left = Math.max(0, route.total - done);
    const b2 = Math.min(c.length - 1, bi + 1);
    const onRoad = [c[bi][0] + (c[b2][0] - c[bi][0]) * bt, c[bi][1] + (c[b2][1] - c[bi][1]) * bt];
    let ahead = bi + 1; while (ahead < c.length - 1 && route.cum[ahead] - done < 30) ahead++;
    const roadHead = bearing(onRoad, c[ahead]);
    if (best < 30) setTarget(onRoad[0], onRoad[1], roadHead);              // pegado a la calle
    else setTarget(me.lat, me.lon, me.speed > 5 ? me.heading : roadHead);
    anim.zoomTo = me.speed > 70 ? 15.2 : me.speed > 40 ? 15.8 : 16.6;

    // Saliendo de un barrio privado o de un predio: línea punteada hasta la ruta, sin recalcular
    if (!nav.joined && best < 40) { nav.joined = true; setConnector(null); }
    if (!nav.joined) {
      setConnector([[me.lon, me.lat], [onRoad[1], onRoad[0]]]);
      $('turn-arrow').innerHTML = arrowSVG(6);
      $('turn-dist').textContent = km(best);
      $('turn-text').textContent = 'Salí hasta la calle de la ruta (línea azul)';
      $('eta-left').textContent = km(left + best);
      $('eta-time').textContent = `Llegás ${clock(route.time * left / route.total)}`;
      if (!nav.spoken.join) { nav.spoken.join = 1; speak('Salí hasta la línea azul y ahí arranca la ruta.'); }
      if (best > 3000 && Date.now() - nav.lastReroute > 60000) reroute(false);
      return;
    }

    $('eta-left').textContent = km(left);
    $('eta-time').textContent = `Llegás ${clock(route.time * left / route.total)}`;

    if (best > 60) nav.off++; else nav.off = 0;
    if (nav.off >= 3) { nav.off = 0; showAlert('Recalculando…', 'orange'); speak('Recalculando.'); reroute(false); return; }

    if (left < 30) {
      $('turn-arrow').innerHTML = arrowSVG(10); $('turn-dist').textContent = ''; $('turn-text').textContent = 'Llegaste a destino';
      if (!nav.spoken.end) { nav.spoken.end = 1; speak('Llegaste a destino.'); if (viaje) setTripState(viaje, 'terminado'); }
      return;
    }
    let si = route.steps.findIndex(s => s.way_points[0] > bi);
    if (si < 0) si = route.steps.length - 1;
    const step = route.steps[si];
    const toStep = Math.max(0, route.cum[step.way_points[0]] - done);
    $('turn-arrow').innerHTML = arrowSVG(step.type);
    $('turn-dist').textContent = km(toStep);
    $('turn-text').textContent = step.text;
    for (const [th, pre] of [[600, 'En 500 metros, '], [220, 'En 200 metros, '], [45, '']]) {
      const k = si + ':' + th;
      if (toStep <= th && !nav.spoken[k]) { nav.spoken[k] = 1; if (!(th === 600 && toStep < 220)) speak(pre + step.text.charAt(0).toLowerCase() + step.text.slice(1)); break; }
    }
    const w = route.near.find(n => n.at > done && n.at - done < 400);
    if (w && !nav.spoken['w' + w.r.id + w.r.t]) {
      nav.spoken['w' + w.r.id + w.r.t] = 1;
      showAlert(`Atención: ${describe(w.r)} en ${km(w.at - done)}`, 'orange');
      setTimeout(() => speak(`Atención. Adelante: ${describe(w.r)}.`), 1500);
    }
  }

  // ---------- Ajustes ----------
  function renderTrucks() {
    const box = $('trucks'); box.textContent = '';
    if (NUBE) { // los camiones los carga el dueño: acá solo se muestran
      for (const T of trucks) {
        const d = document.createElement('div'); d.className = 'item';
        d.innerHTML = `<span class="ico">${T.id === truckId ? '✔' : '🚚'}</span><span><span class="t">${esc(T.name)}</span><br><span class="m">${fmt(T.h)} m alto · ${fmt(T.w)} t · ${fmt(T.l)} m largo · ${fmt(T.wd)} m ancho · ${fmt(T.e)} t por eje${T.hz ? ' · carga peligrosa' : ''}</span></span><span></span>`;
        box.appendChild(d);
      }
      return;
    }
    trucks.forEach((T, i) => {
      const d = document.createElement('div'); d.className = 'tcard';
      d.innerHTML = `<label class="name">Nombre o patente<input type="text" data-k="name" value="${esc(T.name)}"></label>
        <label>Alto (m)<input type="number" inputmode="decimal" step="0.05" data-k="h" value="${T.h}"></label>
        <label>Peso (t)<input type="number" inputmode="decimal" step="0.5" data-k="w" value="${T.w}"></label>
        <label>Largo (m)<input type="number" inputmode="decimal" step="0.5" data-k="l" value="${T.l}"></label>
        <label>Ancho (m)<input type="number" inputmode="decimal" step="0.05" data-k="wd" value="${T.wd}"></label>
        <label>Por eje (t)<input type="number" inputmode="decimal" step="0.5" data-k="e" value="${T.e}"></label>
        <label class="check"><input type="checkbox" data-k="hz" ${T.hz ? 'checked' : ''}> Carga peligrosa</label>
        ${trucks.length > 1 ? '<button type="button" class="del">Borrar este camión</button>' : ''}`;
      d.querySelectorAll('input').forEach(inp => inp.addEventListener('change', () => {
        const k = inp.dataset.k;
        T[k] = k === 'name' ? (inp.value.trim() || 'Camión') : k === 'hz' ? inp.checked : (parseFloat(String(inp.value).replace(',', '.')) || T[k]);
        store.set('trucks', trucks); renderTruckChip(); refreshRestr();
      }));
      const del = d.querySelector('.del');
      if (del) del.addEventListener('click', () => { trucks.splice(i, 1); if (!trucks.some(t => t.id === truckId)) truckId = trucks[0].id; store.set('trucks', trucks); store.set('truckId', truckId); renderTrucks(); renderTruckChip(); });
      box.appendChild(d);
    });
  }
  $('b-add-truck').addEventListener('click', () => {
    trucks.push({ id: 't' + Date.now(), name: 'Camión nuevo', h: 4, w: 40, l: 18, wd: 2.6, e: 10.5, hz: true });
    store.set('trucks', trucks); renderTrucks();
  });
  function renderAvoids() {
    const box = $('avoids'); box.textContent = '';
    if (!avoids.length) { box.innerHTML = '<p class="tip">Todavía no hay calles evitadas.</p>'; return; }
    avoids.forEach((a, i) => {
      const d = document.createElement('div'); d.className = 'item';
      const canDel = !NUBE || a.mine || (prof && prof.rol === 'dueno');
      const who = a.pending ? ' · sin subir todavía' : a.by ? ' · ' + a.by : '';
      d.innerHTML = `<span class="ico">⛔</span><span><span class="t">${esc(a.label || 'Calle sin nombre')}</span><br><span class="m">${esc(a.at)}${esc(who)}</span></span>${canDel ? '<button type="button" class="x" aria-label="Sacar">✕</button>' : '<span></span>'}`;
      d.addEventListener('click', ev => { if (ev.target.closest('.x')) return; $('settings').close(); focusPoint(a.lon, a.lat); });
      if (canDel) d.querySelector('.x').addEventListener('click', async () => {
        if (NUBE && a.id) {
          const { error } = await NUBE.sb.from('bloqueos').delete().eq('id', a.id);
          if (error) { showErr('No se pudo sacar (¿hay señal?).'); return; }
        }
        avoids.splice(i, 1); store.set('avoids', avoids); drawAvoids(); renderAvoids();
      });
      box.appendChild(d);
    });
  }
  $('b-menu').addEventListener('click', () => {
    if (NUBE) {
      $('sec-account').hidden = false; $('sec-key').hidden = true; $('b-add-truck').hidden = true;
      $('acc-name').textContent = prof ? `${prof.nombre}${prof.usuario ? ' (' + prof.usuario + ')' : ''}` : 'Sin conexión';
      $('b-panel').hidden = !(prof && (prof.rol === 'dueno' || prof.rol === 'admin'));
      $('cam-count').textContent = radares.length ? `${radares.length} fotomultas cargadas. Avisa a unos 500 metros y suena si vas más rápido que la máxima.` : 'Todavía no hay fotomultas cargadas.';
      $('s-speed').disabled = true; $('speed-note').textContent = 'km/h. La pone el dueño en el panel. Avisa con sonido y voz si el camión la pasa.';
      $('trucks-note').hidden = false;
    }
    renderTrucks(); renderAvoids();
    $('s-speed').value = speedLimit; $('s-key').value = store.get('key', '') ? '••••••••' : ''; $('s-restr').checked = store.get('showAll', false);
    $('settings').showModal();
  });
  if (NUBE) {
    $('b-logout').addEventListener('click', async () => {
      if (!confirm('¿Salir de la cuenta? Para volver a entrar vas a necesitar tu usuario y PIN.')) return;
      $('settings').close(); store.set('trip', null); await NUBE.salir();
    });
  }
  $('s-speed').addEventListener('change', () => { const v = parseInt($('s-speed').value, 10); if (v >= 40 && v <= 130) { speedLimit = v; store.set('speedLimit', v); } });
  for (const ev of ['change', 'input']) $('s-key').addEventListener(ev, () => { const v = $('s-key').value.trim(); if (v.length > 20 && !/^•+$/.test(v)) { store.set('key', v); showErr(''); } });


  // ---------- Nube: cuenta del chofer, viajes, lugares, calles marcadas y ubicación en vivo ----------
  let session = null, prof = null, channel = null;
  function showLogin() {
    if (!NUBE) return;
    const d = $('login'); if (d.open) return;
    $('l-err').hidden = true; $('l-pin').value = '';
    d.showModal(); setTimeout(() => $('l-user').focus(), 50);
  }
  if (NUBE) {
    $('login').addEventListener('cancel', e => e.preventDefault()); // no se puede cerrar sin entrar
    $('l-user').value = store.get('lastUser', '');
    // Con email (dueño o administrador) la clave puede tener letras: teclado completo; con usuario de chofer, numérico
    const tecladoPin = () => { const conEmail = $('l-user').value.includes('@'); $('l-pin').inputMode = conEmail ? 'text' : 'numeric'; $('l-pin').previousSibling && ($('l-pin').closest('label').firstChild.textContent = conEmail ? 'Contraseña' : 'PIN'); };
    $('l-user').addEventListener('input', tecladoPin); tecladoPin();
    $('f-login').addEventListener('submit', async e => {
      e.preventDefault();
      const u = $('l-user').value.trim(), pin = $('l-pin').value.trim();
      if (!u || !pin) return;
      $('l-go').disabled = true; $('l-go').textContent = 'Entrando…'; $('l-err').hidden = true;
      try {
        await NUBE.entrar(u, pin);
        store.set('lastUser', u);
        $('login').close();
        await startCloud();
      } catch (err) { $('l-err').textContent = err.message; $('l-err').hidden = false; }
      finally { $('l-go').disabled = false; $('l-go').textContent = 'Entrar'; }
    });
    NUBE.sb.auth.onAuthStateChange((ev, s) => {
      session = s || null;
      if (ev === 'SIGNED_OUT') { prof = null; if (channel) { NUBE.sb.removeChannel(channel); channel = null; } showLogin(); }
      else if (ev === 'SIGNED_IN' || ev === 'TOKEN_REFRESHED') flushAvoids();
    });
    window.addEventListener('online', () => { flushAvoids(); loadCloud(); });
  }

  async function startCloud() {
    session = await NUBE.sesion();
    if (!session) { showLogin(); return; }
    try { prof = await NUBE.cargarPerfil(); } catch (e) { prof = store.get('perfil', null); }
    if (!prof && navigator.onLine) { await NUBE.salir(); showLogin(); return; }
    await loadCloud();
    subscribe();
    flushAvoids();
  }

  const lugaresVisibles = () => lugares.filter(l => !String(l.nombre).startsWith('Viaje · ')); // las de un solo viaje no se listan
  const lugarIco = t => ({ base: '🏠', deposito: '📦', cliente: '🏭' }[t] || '📍');
  async function loadCloud() {
    if (!NUBE || !session) return;
    const uid = session.user.id;
    const [cam, lug, aj, blo, via] = await Promise.all([
      NUBE.sb.from('camiones').select('*').eq('activo', true).order('nombre'),
      NUBE.sb.from('lugares').select('*').order('nombre'),
      NUBE.sb.from('ajustes').select('velocidad_max').eq('id', 1).maybeSingle(),
      NUBE.sb.from('bloqueos').select('id, lat, lon, calle, creado, creado_por').eq('activo', true).order('creado', { ascending: false }),
      NUBE.sb.from('viajes').select('*').eq('chofer_id', uid).in('estado', ['pendiente', 'en_curso']).order('fecha').order('creado'),
    ]);
    if (!cam.error && cam.data.length) {
      trucks = cam.data.map(NUBE.camionApp); store.set('trucks', trucks);
      if (!trucks.some(t => t.id === truckId)) { truckId = (prof && trucks.some(t => t.id === prof.camion_id)) ? prof.camion_id : trucks[0].id; store.set('truckId', truckId); }
      renderTruckChip(); refreshRestr();
    }
    if (!lug.error) { lugares = lug.data; store.set('lugares', lugares); drawLugares(); }
    if (!aj.error && aj.data) { speedLimit = aj.data.velocidad_max; store.set('speedLimit', speedLimit); }
    if (!blo.error) {
      const pending = avoids.filter(a => a.pending);
      avoids = blo.data.map(b => ({ id: b.id, lat: b.lat, lon: b.lon, label: b.calle || 'Calle sin nombre', at: b.creado.slice(0, 10), mine: b.creado_por === uid })).concat(pending);
      store.set('avoids', avoids); drawAvoids();
    }
    if (!via.error) { viajes = via.data; store.set('viajes', viajes); }
    loadRadares(); loadReportes(); loadOficiales();
    if (mode === 'home') renderFavs();
  }

  // Cambios en vivo: calles marcadas por otros choferes, viajes nuevos, ajustes del dueño
  let reloadT = 0;
  function subscribe() {
    if (channel) return;
    const later = () => { clearTimeout(reloadT); reloadT = setTimeout(loadCloud, 600); };
    channel = NUBE.sb.channel('chofer-' + session.user.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bloqueos' }, p => {
        if (p.eventType === 'INSERT' && p.new.creado_por !== session.user.id && mode === 'nav') showAlert(`Otro chofer marcó: ${p.new.calle || 'una calle'} — No se puede pasar`, 'orange');
        later();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viajes', filter: `chofer_id=eq.${session.user.id}` }, p => {
        if (p.eventType === 'INSERT') { beep(); showAlert('Tenés un viaje nuevo', 'orange'); speak('Tenés un viaje nuevo.'); }
        later();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ajustes' }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'camiones' }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lugares' }, later)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'radares' }, () => { clearTimeout(camT); camT = setTimeout(loadRadares, 2000); })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'reportes' }, () => { clearTimeout(repT); repT = setTimeout(loadReportes, 1500); })
      .subscribe();
  }

  // ---------- Fotomultas ----------
  let camT = 0, repT = 0;
  async function loadRadares() {
    if (!NUBE || !session) return;
    const out = [];
    for (let from = 0; ; from += 1000) {   // de a 1000 (límite del servidor)
      const { data, error } = await NUBE.sb.from('radares').select('id, lat, lon, maxima').eq('activo', true).order('id').range(from, from + 999);
      if (error) return;               // sin señal: quedan las guardadas en el celular
      out.push(...data);
      if (data.length < 1000) break;
    }
    radares = out; store.set('radares', radares); drawRadares();
  }
  function drawRadares() {
    const src = map.getSource && map.getSource('radares'); if (!src) return;
    src.setData({ type: 'FeatureCollection', features: radares.map(r => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { icon: 'cm|' + (r.maxima || '?') } })) });
  }
  // Avisa cuando hay una fotomulta adelante (en el sentido en que va el camión): a unos 500 m, y suena si al acercarse va más rápido
  const camWarn = {};
  function checkCameras() {
    if (!radares.length || !me || (me.speed || 0) < 20) return;
    const v = Math.round(me.speed), head = me.heading || 0, now = Date.now();
    for (const r of radares) {
      if (Math.abs(r.lat - me.lat) > 0.006 || Math.abs(r.lon - me.lon) > 0.008) continue;   // lejos (~600 m)
      const d = dist([me.lat, me.lon], [r.lat, r.lon]);
      if (d > 520 || d < 15) continue;
      const delta = Math.abs(((bearing([me.lat, me.lon], [r.lat, r.lon]) - head + 540) % 360) - 180);
      if (delta > (d < 120 ? 50 : 28)) continue;                                              // no está adelante
      const w = camWarn[r.id] || (camWarn[r.id] = { at: 0, lvl: 0 });
      if (now - w.at > 8 * 60 * 1000) w.lvl = 0;
      const max = r.maxima, metros = Math.max(50, Math.round(d / 50) * 50);
      if (w.lvl < 1) {
        w.lvl = 1; w.at = now;
        showAlert(`📷 Fotomulta a ${metros} m${max ? ' · máx. ' + max + ' km/h' : ''}`, 'orange');
        speak(`Atención. Fotomulta a ${metros} metros.${max ? ' Máxima ' + max + '.' : ''}`);
      } else if (w.lvl < 2 && d < 250 && max && v > max) {
        w.lvl = 2; w.at = now; beep();
        showAlert(`¡Bajá! Fotomulta adelante · máx. ${max} km/h`);
        speak(`Bajá la velocidad. Fotomulta. Máxima ${max}.`);
      }
    }
  }

  // ---------- Restricciones oficiales (normativa con su fuente) ----------
  // Se suman a las de OpenStreetMap: se ven como carteles, se avisan en la ruta y se esquivan si el camión no cumple.
  async function loadOficiales() {
    if (!NUBE || !session) return;
    let data = store.get('oficiales', null);
    const res = await NUBE.sb.from('restricciones_oficiales').select('id, tipo, ruta, km, provincia, nombre, valor, valor_eje, lat, lon, nota, fuente, fuente_url').eq('activo', true).not('lat', 'is', null).limit(5000);
    if (!res.error) { data = res.data; store.set('oficiales', data); }
    if (!data) return;
    oficialRows = [];
    for (const o of data) {
      const t = o.tipo === 'peso' ? 'W' : o.tipo === 'peso_eje' ? 'E' : o.tipo === 'altura' ? 'A' : o.tipo === 'largo' ? 'L' : 'P';
      const num = t === 'E' ? o.valor_eje : o.valor;
      const base = { id: o.id, et: 'node', prov: o.provincia, loc: [o.ruta, o.km != null ? 'km ' + fmt(o.km) : ''].filter(Boolean).join(' '), street: o.nombre || 'Puente',
        raw: num, num: num == null ? NaN : +num, lat: o.lat, lon: o.lon, oficial: o.fuente, fuenteUrl: o.fuente_url, nota: o.nota, dubious: false };
      oficialRows.push({ ...base, t });
      if (t === 'W' && o.valor_eje) oficialRows.push({ ...base, id: o.id + 'e', t: 'E', raw: o.valor_eje, num: +o.valor_eje });   // también límite por eje
    }
    rows = rows.filter(r => !r.oficial).concat(oficialRows);
    refreshRestr();
  }

  // ---------- Reportes de los choferes (botón ⚠️) ----------
  // bache, camino roto, control, balanza, corte, puente bajo, calle angosta: quedan para todos.
  // Los cortes se esquivan en las rutas; lo demás se avisa al acercarse.
  const REP = {
    bache: ['🕳️', 'Bache'], camino_roto: ['🚧', 'Camino roto'], control: ['👮', 'Control'], balanza: ['⚖️', 'Balanza'],
    corte: ['⛔', 'Corte'], altura: ['🌉', 'Puente bajo'], angosta: ['↔️', 'Calle angosta'], otro: ['⚠️', 'Atención'],
    inseguro: ['🚨', 'Zona insegura'],
  };
  let reportes = NUBE ? store.get('reportes', []) : [];
  async function loadReportes() {
    if (!NUBE || !session) return;
    const { data, error } = await NUBE.sb.from('reportes').select('id, tipo, lat, lon, dato, confirmaciones, creado_por').eq('activo', true).limit(5000);
    if (error) return;
    reportes = data; store.set('reportes', reportes); drawReportes();
  }
  function drawReportes() {
    const src = map.getSource && map.getSource('reportes'); if (!src) return;
    src.setData({ type: 'FeatureCollection', features: reportes.map(r => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { icon: 'rp|' + r.tipo, id: r.id } })) });
  }
  function makeRep(id) {
    const t = id.split('|')[1], S = 96, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = t === 'corte' ? '#c8102e' : t === 'control' || t === 'balanza' ? '#1d3f9a' : '#e07a00';
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 4, 0, Math.PI * 2); g.fill();
    g.lineWidth = 6; g.strokeStyle = '#fff'; g.stroke();
    g.font = '46px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText((REP[t] || REP.otro)[0], S / 2, S / 2 + 3);
    return g.getImageData(0, 0, S, S);
  }
  // Aviso al acercarse a un reporte que está adelante (el puente bajo, solo si el camión no pasa)
  const repWarn = {};
  function checkReportes() {
    if (!reportes.length || !me || (me.speed || 0) < 10) return;
    const head = me.heading || 0, now = Date.now(), T = truck();
    for (const r of reportes) {
      if (Math.abs(r.lat - me.lat) > 0.005 || Math.abs(r.lon - me.lon) > 0.006) continue;
      const d = dist([me.lat, me.lon], [r.lat, r.lon]);
      if (d > 420 || d < 15) continue;
      if (Math.abs(((bearing([me.lat, me.lon], [r.lat, r.lon]) - head + 540) % 360) - 180) > (d < 120 ? 50 : 30)) continue;
      if (r.tipo === 'altura' && r.dato && T && T.h < r.dato - 0.1) continue;
      if (repWarn[r.id] && now - repWarn[r.id] < 10 * 60 * 1000) continue;
      repWarn[r.id] = now;
      const [ico, nombre] = REP[r.tipo] || REP.otro, metros = Math.max(50, Math.round(d / 50) * 50);
      const extra = r.tipo === 'altura' && r.dato ? ` de ${fmt(r.dato)} m` : '';
      if (r.tipo === 'inseguro') {   // marcada por otros choferes (robos, piratas del asfalto)
        showAlert(`🚨 Zona insegura a ${metros} m: no te detengas`, 'orange');
        speak(`Precaución. Zona insegura marcada por otros choferes a ${metros} metros. No te detengas.`);
        continue;
      }
      showAlert(`${ico} ${nombre}${extra} a ${metros} m`, 'orange');
      speak(`Atención. ${nombre}${extra ? ' de ' + String(r.dato).replace('.', ' coma ') + ' metros' : ''} a ${metros} metros.`);
      if (r.tipo === 'altura' || r.tipo === 'corte') beep();
    }
  }
  async function enviarReporte(tipo, dato) {
    if (!me) { showAlert('Todavía no tengo tu ubicación.', 'orange'); return; }
    const cerca = reportes.find(r => r.tipo === tipo && dist([me.lat, me.lon], [r.lat, r.lon]) < 80);
    if (cerca) {   // ya estaba: se confirma (dura más)
      await NUBE.sb.rpc('confirmar_reporte', { p_id: cerca.id }).then(() => {}, () => {});
      showAlert(`${REP[tipo][0]} Ya estaba marcado: lo confirmaste. ¡Gracias!`, 'orange'); return;
    }
    const { data, error } = await NUBE.sb.from('reportes').insert({ tipo, lat: +me.lat.toFixed(6), lon: +me.lon.toFixed(6), dato: dato || null, creado_por: session.user.id })
      .select('id, tipo, lat, lon, dato, confirmaciones, creado_por').single();
    if (error) { showAlert('No se pudo marcar (¿hay señal?). Probá de nuevo.', 'orange'); return; }
    reportes.push(data); store.set('reportes', reportes); drawReportes(); repWarn[data.id] = Date.now();
    showAlert(`${REP[tipo][0]} ${REP[tipo][1]} marcado. ¡Gracias!`, 'orange'); speak(`${REP[tipo][1]} marcado. Gracias.`);
    if (tipo === 'corte' && route && mode === 'nav') { avoids.push({ lat: data.lat, lon: data.lon, label: 'Corte', at: new Date().toISOString().slice(0, 10), mine: true }); reroute(true); }
  }
  if (NUBE) {
    $('b-camara').addEventListener('click', () => { $('rep-dlg').returnValue = ''; $('rep-dlg').showModal(); });
    $('rep-dlg').addEventListener('close', () => {
      const t = $('rep-dlg').returnValue; if (!t) return;
      if (t === 'fotomulta') { $('cam-dlg').returnValue = ''; $('cam-dlg').showModal(); }
      else if (t === 'altura') { $('alt-dlg').returnValue = ''; $('alt-dlg').showModal(); }
      else enviarReporte(t);
    });
    $('alt-dlg').addEventListener('close', () => { const v = $('alt-dlg').returnValue; if (v !== '') enviarReporte('altura', +v || null); });
  }

  // Marcar una fotomulta que falta: queda para todos los choferes
  if (NUBE) {
    $('cam-dlg').addEventListener('close', async () => {
      const v = $('cam-dlg').returnValue; if (v === '') return;
      if (!me) { showAlert('Todavía no tengo tu ubicación.', 'orange'); return; }
      const cerca = radares.find(r => dist([me.lat, me.lon], [r.lat, r.lon]) < 60);
      if (cerca && (+v === 0 || cerca.maxima === +v)) { showAlert('Esa fotomulta ya estaba cargada. ¡Gracias!', 'orange'); return; }
      const row = { lat: +me.lat.toFixed(6), lon: +me.lon.toFixed(6), maxima: +v || null, creado_por: session.user.id, nota: 'Marcada desde la app' };
      const { data, error } = await NUBE.sb.from('radares').insert(row).select('id, lat, lon, maxima').single();
      if (error) { showAlert('No se pudo marcar (¿hay señal?). Probá de nuevo.', 'orange'); return; }
      radares.push(data); store.set('radares', radares); drawRadares();
      camWarn[data.id] = { at: Date.now(), lvl: 2 };   // no avisar de la que se acaba de marcar
      showAlert(`📷 Fotomulta marcada${+v ? ' (máx. ' + v + ')' : ''}. ¡Gracias!`, 'orange'); speak('Fotomulta marcada. Gracias.');
    });
  }

  // Ubicación en vivo para el panel del dueño (cada 15 s o cada 150 m; en viaje, cada 5 s)
  const lastPos = { at: 0, lat: 0, lon: 0, busy: false };
  async function sendPos(acc) {
    if (!NUBE || !session || !prof || !me || lastPos.busy) return;
    const now = Date.now(), moved = dist([lastPos.lat, lastPos.lon], [me.lat, me.lon]);
    if (now - lastPos.at < (mode === 'nav' ? 5000 : 15000) && moved < 150) return;
    lastPos.busy = true;
    try {
      const { error } = await NUBE.sb.from('posiciones').upsert({
        chofer_id: session.user.id, camion_id: isUuid(truckId) ? truckId : null, viaje_id: viaje ? viaje.id : null,
        lat: +me.lat.toFixed(6), lon: +me.lon.toFixed(6), velocidad: Math.round(me.speed || 0), rumbo: Math.round(me.heading || 0),
        precision_m: Number.isFinite(acc) ? Math.round(acc) : null, at: new Date().toISOString(),
      }, { onConflict: 'chofer_id' });
      if (!error) Object.assign(lastPos, { at: now, lat: me.lat, lon: me.lon });
    } catch (e) { /* sin señal: se manda en la próxima */ }
    finally { lastPos.busy = false; }
  }
  // La ruta que va a seguir el chofer: la ve el dueño en el panel (simplificada a unos 400 puntos)
  function routeGeo(rt) {
    const c = rt.coords, step = Math.max(1, Math.ceil(c.length / 400)), out = [];
    for (let i = 0; i < c.length; i += step) out.push([+c[i][1].toFixed(5), +c[i][0].toFixed(5)]);
    const last = c[c.length - 1]; out.push([+last[1].toFixed(5), +last[0].toFixed(5)]);
    return { type: 'LineString', coordinates: out };
  }
  async function shareRoute(rt) {
    if (!NUBE || !session || !prof) return;
    try {
      const geo = rt ? routeGeo(rt) : null;
      const p = me || (rt && rt.from);
      if (p) await NUBE.sb.from('posiciones').upsert({ chofer_id: session.user.id, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6),
        camion_id: isUuid(truckId) ? truckId : null, viaje_id: viaje ? viaje.id : null, ruta: geo, destino: rt ? rt.to.label : null, at: new Date().toISOString() }, { onConflict: 'chofer_id' });
      if (rt && viaje) await NUBE.sb.rpc('guardar_ruta_viaje', { p_viaje: viaje.id, p_ruta: geo, p_km: +(rt.total / 1000).toFixed(1), p_min: Math.round(rt.time / 60) });
    } catch (e) { /* sin señal: se manda en el próximo recálculo */ }
  }
  // Una alerta por tramo de exceso: se crea al pasarse, se actualiza la máxima cada 30 s
  // y se cierra cuando vuelve a ir bien durante 15 s. El chofer igual escucha la alarma cada 20 s.
  const ep = { id: null, pending: false, max: 0, upd: 0, below: 0, maxPos: null };
  function speedEpisode(v, over) {
    if (!NUBE || !session || !me) return;
    const now = Date.now();
    if (over) {
      ep.below = 0;
      if (v >= ep.max) { ep.max = v; ep.maxPos = { lat: +me.lat.toFixed(6), lon: +me.lon.toFixed(6) }; }
      if (!ep.id && !ep.pending) {
        ep.pending = true; ep.upd = now;
        NUBE.sb.from('alertas').insert({ chofer_id: session.user.id, camion_id: isUuid(truckId) ? truckId : null, viaje_id: viaje ? viaje.id : null,
          velocidad: v, limite: speedLimit, ...ep.maxPos, fin: new Date().toISOString() }).select('id').single()
          .then(({ data }) => { ep.id = data ? data.id : null; ep.pending = false; }, () => { ep.pending = false; });
      } else if (ep.id && now - ep.upd > 30000) { ep.upd = now; closeEpisode(false); }
    } else if (ep.id) {
      if (!ep.below) ep.below = now;
      if (now - ep.below > 15000) closeEpisode(true);
    }
  }
  function closeEpisode(final) {
    if (!ep.id) return;
    NUBE.sb.from('alertas').update({ velocidad: ep.max, ...ep.maxPos, fin: new Date().toISOString() }).eq('id', ep.id).then(() => {}, () => {});
    if (final) Object.assign(ep, { id: null, max: 0, below: 0, maxPos: null });
  }
  async function setTripState(v, estado) {
    if (!NUBE || !v || v.estado === estado || v.estado === 'terminado') return;
    v.estado = estado; store.set('viajes', viajes);
    try { await NUBE.sb.rpc('cambiar_estado_viaje', { p_viaje: v.id, p_estado: estado }); } catch (e) { /* se reintenta al recargar */ }
    if (estado === 'terminado') { viajes = viajes.filter(x => x.id !== v.id); store.set('viajes', viajes); }
  }

  // Viajes asignados y lugares de la empresa, arriba de los favoritos
  const fechaCorta = f => { const d = new Date(f + 'T12:00:00'); const hoy = new Date(); const man = new Date(Date.now() + 864e5);
    return d.toDateString() === hoy.toDateString() ? 'Hoy' : d.toDateString() === man.toDateString() ? 'Mañana' : d.toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'numeric' }); };
  function renderCloudLists(box) {
    if (!NUBE) return;
    const byId = id => lugares.find(l => l.id === id);
    if (viajes.length) {
      const h = document.createElement('h3'); h.className = 'list-title'; h.textContent = 'Tus viajes'; box.appendChild(h);
      for (const v of viajes) {
        const dest = byId(v.destino_id), orig = byId(v.origen_id), T = trucks.find(t => t.id === v.camion_id);
        const b = document.createElement('div'); b.setAttribute('role', 'button'); b.tabIndex = 0; b.className = 'item trip' + (v.estado === 'en_curso' ? ' resume' : '');
        const sub = [fechaCorta(v.fecha), orig ? 'desde ' + orig.nombre : '', T ? T.name : '', v.notas].filter(Boolean).join(' · ');
        b.innerHTML = `<span class="ico">${v.estado === 'en_curso' ? '▶' : '🚚'}</span><span><span class="t">${esc(dest ? nombreLugar(dest.nombre) : 'Destino borrado')}</span><br><span class="m">${esc(sub)}</span></span>` +
          (v.estado === 'en_curso' ? '<span class="trip-acts"><span class="tag">Seguir</span><button type="button" class="end">Terminar</button></span>' : '<span class="tag">Ir</span>');
        b.addEventListener('keydown', ev => { if (ev.key === 'Enter') b.click(); });
        b.addEventListener('click', ev => {
          if (ev.target.closest('.end')) {
            if (!confirm(`¿Terminaste el viaje a ${dest ? nombreLugar(dest.nombre) : 'este destino'}? Deja de aparecer en tus viajes.`)) return;
            setTripState(v, 'terminado').then(renderFavs); renderFavs(); return;
          }
          if (!dest) { showErr('El destino de este viaje ya no existe. Avisale al dueño.'); return; }
          if (v.camion_id && trucks.some(t => t.id === v.camion_id) && truckId !== v.camion_id) { truckId = v.camion_id; store.set('truckId', truckId); renderTruckChip(); }
          viaje = v;
          goTo({ label: nombreLugar(dest.nombre), lat: dest.lat, lon: dest.lon }, true);
        });
        box.appendChild(b);
      }
    }
    if (lugaresVisibles().length) {
      const det = document.createElement('details'); det.className = 'places';
      det.innerHTML = `<summary>Lugares de la empresa (${lugaresVisibles().length})</summary>`;
      const list = document.createElement('div'); list.className = 'list';
      for (const l of lugaresVisibles()) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'item';
        b.innerHTML = `<span class="ico">${lugarIco(l.tipo)}</span><span><span class="t">${esc(l.nombre)}</span><br><span class="m">${esc([l.direccion, l.notas].filter(Boolean).join(' · '))}</span></span><span></span>`;
        b.addEventListener('click', () => goTo({ label: l.nombre, lat: l.lat, lon: l.lon }));
        list.appendChild(b);
      }
      det.appendChild(list); box.appendChild(det);
    }
  }
  function drawLugares() {
    const src = map.getSource && map.getSource('lugares'); if (!src) return;
    src.setData({ type: 'FeatureCollection', features: lugaresVisibles().map(l => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon, l.lat] }, properties: { id: l.id } })) });
  }
  function lugarPopup(l) {
    const div = document.createElement('div');
    div.innerHTML = `<p style="margin:0"><b>${lugarIco(l.tipo)} ${esc(l.nombre)}</b></p>${l.notas ? `<p class="m" style="margin:4px 0 0">${esc(l.notas)}</p>` : ''}<div class="pop-actions"><button type="button" class="big go">Ir acá</button></div>`;
    const pop = new maplibregl.Popup().setLngLat([l.lon, l.lat]).setDOMContent(div).addTo(map);
    div.querySelector('button').addEventListener('click', () => { pop.remove(); goTo({ label: l.nombre, lat: l.lat, lon: l.lon }); });
  }
  const norm = t => String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const lugaresQueCoinciden = text => { const q = norm(text); return lugaresVisibles().filter(l => norm(l.nombre).includes(q) || (l.direccion && norm(l.direccion).includes(q)))
    .map(l => ({ label: `${l.nombre}${l.direccion ? ', ' + l.direccion : ''}`, lat: l.lat, lon: l.lon, poi: true, own: true })); };

  // ---------- Instalar ----------
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('b-install').hidden = false; });
  $('b-install').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('b-install').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  // ---------- Carteles de restricción (círculo rojo como las señales de Vialidad) ----------
  function signId(r) {
    const lab = (r.t === 'P' || r.t === 'D') ? 'truck' : r.t === 'H' ? 'ONU' : (Number.isFinite(r.num) ? fmt(r.num) : '?');
    return `sg|${lab}`;
  }
  const TRUCK_PATH = 'M2 7h11v8H2zM13 10h4l3 3v2h-7zM4 17.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M14 17.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0';
  function makeSign(id) {
    const lab = id.split('|')[1], S = 96, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 3, 0, Math.PI * 2); g.fillStyle = '#c8102e'; g.fill();
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 - 14, 0, Math.PI * 2); g.fillStyle = '#fff'; g.fill();
    g.fillStyle = '#111';
    if (lab === 'truck') { g.save(); g.translate(20, 18); g.scale(2.4, 2.4); g.fill(new Path2D(TRUCK_PATH)); g.restore(); }
    else { g.font = `700 ${lab.length > 3 ? 26 : 32}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(lab, S / 2, S / 2 + 2); }
    if (lab === 'truck' || lab === 'ONU') { g.save(); g.translate(S / 2, S / 2); g.rotate(-Math.PI / 4); g.fillStyle = '#c8102e'; g.fillRect(-S / 2 + 12, -5, S - 24, 10); g.restore(); }
    return g.getImageData(0, 0, S, S);
  }
  map.on('styleimagemissing', e => {
    if (map.hasImage(e.id)) return;
    if (e.id.startsWith('sg|')) map.addImage(e.id, makeSign(e.id), { pixelRatio: 2 });
    else if (e.id.startsWith('cm|')) map.addImage(e.id, makeCam(e.id), { pixelRatio: 2 });
    else if (e.id.startsWith('rp|')) map.addImage(e.id, makeRep(e.id), { pixelRatio: 2 });
  });
  // Fotomulta: cartel azul con camarita y la velocidad máxima
  function makeCam(id) {
    const lab = id.split('|')[1], S = 96, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(2, 2, S - 4, S - 4, 18); g.fill();
    g.fillStyle = '#1d3f9a'; g.beginPath(); g.roundRect(8, 8, S - 16, S - 16, 13); g.fill();
    g.fillStyle = '#fff'; g.beginPath(); g.roundRect(26, 16, 36, 22, 5); g.fill();
    g.beginPath(); g.moveTo(62, 22); g.lineTo(74, 16); g.lineTo(74, 38); g.lineTo(62, 32); g.fill();
    g.fillStyle = '#1d3f9a'; g.beginPath(); g.arc(44, 27, 6, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = `700 ${lab.length > 2 ? 34 : 38}px "Barlow Condensed", "Arial Narrow", Arial, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(lab, S / 2, 64);
    return g.getImageData(0, 0, S, S);
  }

  // ---------- Mapa más claro para camioneros ----------
  function vectorSource() {
    const st = map.getStyle(); if (!st) return null;
    return Object.keys(st.sources).find(k => st.sources[k].type === 'vector') || null;
  }
  function tuneStyle() {
    try {
      const src = vectorSource(); if (!src) return;
      const layers = map.getStyle().layers;
      let font = null;
      for (const l of layers) {
        const sl = l['source-layer'];
        if (!font && l.type === 'symbol' && l.layout && l.layout['text-font']) font = l.layout['text-font'];
        if (sl === 'poi' || sl === 'aerodrome_label') map.setLayoutProperty(l.id, 'visibility', 'none');
        if (sl === 'transportation' && /path|foot|cycle|pedestrian|steps|bridleway|ferry/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
        if (l.type === 'symbol' && sl === 'transportation_name') map.setLayoutProperty(l.id, 'text-size', ['interpolate', ['linear'], ['zoom'], 10, 12, 14, 15, 17, 19]);
      }
      // Estaciones de servicio: lo único que queda de los "puntos de interés"
      if (!map.getLayer('fuel')) {
        map.addLayer({ id: 'fuel', type: 'circle', source: src, 'source-layer': 'poi', minzoom: 11, filter: ['==', ['get', 'class'], 'fuel'],
          paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 8], 'circle-color': '#12873e', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } }, 'route-casing');
        if (font) map.addLayer({ id: 'fuel-label', type: 'symbol', source: src, 'source-layer': 'poi', minzoom: 13, filter: ['==', ['get', 'class'], 'fuel'],
          layout: { 'text-field': ['coalesce', ['get', 'name'], 'Combustible'], 'text-font': font, 'text-size': 13, 'text-offset': [0, 1.3], 'text-anchor': 'top' },
          paint: { 'text-color': '#0b5d2a', 'text-halo-color': '#fff', 'text-halo-width': 1.5 } }, 'route-casing');
      }
    } catch (e) { console.warn('estilo', e); }
  }

  // ---------- Viaje sin señal ----------
  // Al tocar IR se baja el mapa de una franja alrededor del recorrido y queda guardado en el celular.
  let dl = { token: 0 };
  function tileXY(lat, lon, z) {
    const n = 2 ** z, x = Math.floor((lon + 180) / 360 * n);
    const r = lat * Math.PI / 180, y = Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    return [x, Math.max(0, Math.min(n - 1, y))];
  }
  function corridorTiles(rt) {
    const set = new Set(), add = (z, x, y) => set.add(`${z}/${x}/${y}`);
    const spec = [[14, 1, 400], [12, 1, 2000], [10, 1, 8000], [8, 0, 30000], [6, 0, 100000]];
    for (const [z, rad, every] of spec) {
      let next = 0;
      for (let i = 0; i < rt.coords.length; i++) {
        if (rt.cum[i] < next && i !== rt.coords.length - 1) continue;
        next = rt.cum[i] + every;
        const [x, y] = tileXY(rt.coords[i][0], rt.coords[i][1], z);
        for (let dx = -rad; dx <= rad; dx++) for (let dy = -rad; dy <= rad; dy++) add(z, x + dx, y + dy);
      }
    }
    const [dx0, dy0] = tileXY(rt.to.lat, rt.to.lon, 14);
    for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) add(14, dx0 + dx, dy0 + dy);
    return [...set];
  }
  function offlineMsg(text, done) {
    for (const id of ['offline', 'offline-pill']) { const el = $(id); if (!el) continue; el.textContent = text; el.hidden = !text; el.classList.toggle('done', !!done); }
  }
  async function downloadCorridor(rt) {
    const token = ++dl.token;
    const src = vectorSource(), source = src && map.getSource(src);
    const tmpl = source && source.tiles && source.tiles[0];
    if (!tmpl || !('serviceWorker' in navigator) || !navigator.serviceWorker.controller) { offlineMsg(''); return; }
    const tiles = corridorTiles(rt).slice(0, 5000);
    let done = 0, fail = 0;
    offlineMsg('Guardando el mapa del viaje para usarlo sin señal… 0%');
    const queue = tiles.slice();
    async function worker() {
      while (queue.length && token === dl.token) {
        const [z, x, y] = queue.shift().split('/');
        try { const r = await fetch(tmpl.replace('{z}', z).replace('{x}', x).replace('{y}', y)); if (!r.ok) fail++; } catch (e) { fail++; }
        done++;
        if (done % 25 === 0) offlineMsg(`Guardando el mapa del viaje para usarlo sin señal… ${Math.round(done / tiles.length * 100)}%`);
      }
    }
    await Promise.all(Array.from({ length: 6 }, worker));
    if (token !== dl.token) return;
    if (fail > tiles.length * 0.2) offlineMsg('No se pudo guardar todo el mapa del viaje. Si hay señal, se va completando.');
    else { offlineMsg('✓ Mapa del viaje guardado: podés seguir aunque no haya señal.', true); setTimeout(() => { const p = $('offline-pill'); if (p) p.hidden = true; }, 8000); }
  }
  function saveTrip() {
    if (!route) return;
    store.set('trip', { at: Date.now(), from: route.from, to: route.to, coords: route.coords, steps: route.steps, time: route.time, viaje: viaje && viaje.id });
  }
  function restoreTrip() {
    const t = store.get('trip', null);
    if (!t || Date.now() - t.at > 48 * 3600 * 1000 || !t.coords) return;
    const box = $('favs');
    const b = document.createElement('button'); b.type = 'button'; b.className = 'item resume';
    b.innerHTML = `<span class="ico">▶</span><span><span class="t">Seguir viaje</span><br><span class="m">${esc(t.to.label)}</span></span><span></span>`;
    b.addEventListener('click', () => {
      const cum = cumOf(t.coords);
      route = { from: t.from, to: t.to, coords: t.coords, cum, steps: t.steps, total: cum[cum.length - 1], time: t.time,
        geo: { type: 'LineString', coordinates: t.coords.map(([la, lo]) => [lo, la]) } };
      route.near = nearRoute(route, 25);
      viaje = t.viaje ? viajes.find(v => v.id === t.viaje) || null : null;
      drawRoute(route);
      $('b-go').click();
    });
    box.prepend(b);
  }

  // ---------- Arranque ----------
  renderTruckChip(); setMode('home');
  if (NUBE) startCloud().catch(() => showLogin());
  Promise.all([
    fetch('data/restricciones.json').then(r => r.json()),
    fetch('data/propias.json').then(r => r.json()).catch(() => []),
  ]).then(([d, own]) => {
    window.__OWN = own;
    rows = d.rows.map(([id, et, pi, loc, street, t, raw, lat, lon, segs]) => {
      const num = parseVal(t, raw);
      return { id, et: et === 'w' ? 'way' : 'node', prov: d.provs[pi], loc, street, t, raw, num, lat, lon, segs,
        dubious: (t in RANGE) && (!Number.isFinite(num) || num < RANGE[t][0] || num > RANGE[t][1]) };
    }).concat(oficialRows);
    ready.then(refreshRestr);
  }).catch(() => showErr('No pude cargar las restricciones. Revisá la conexión.'));
  getMe().then(p => map.jumpTo({ center: [p.lon, p.lat], zoom: 14 })).catch(() => {});
})();
