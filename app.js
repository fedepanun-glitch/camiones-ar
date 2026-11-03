/* Camiones AR — app para choferes.
   Mapa vectorial (MapLibre + OpenFreeMap), rutas para camión (openrouteservice), navegación con voz,
   alerta de velocidad y "No puedo pasar" para esquivar calles que en la realidad no sirven. */
(() => {
  'use strict';
  const ORS = 'https://api.openrouteservice.org';
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
  const key = () => (store.get('key', '') || CFG.orsKey || '').trim();
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
  let rows = [];
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
    map.addSource('avoid', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'avoid', type: 'circle', source: 'avoid', paint: { 'circle-radius': 9, 'circle-color': cssVar('--warn'), 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    map.addSource('route', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'route-casing', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 12 } });
    map.addLayer({ id: 'route', type: 'line', source: 'route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': cssVar('--route'), 'line-width': 7 } });
    map.addSource('restr', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'restr', type: 'symbol', source: 'restr', layout: {
      'icon-image': ['get', 'icon'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
      'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.32, 13, 0.5, 17, 0.75] } });
    tuneStyle();
    if (route) map.getSource('route').setData({ type: 'Feature', geometry: route.geo, properties: {} });
    drawAvoids(); refreshRestr();
    if (handlersOn) return; handlersOn = true;
    map.on('click', 'restr', e => { e.preventDefault(); const r = rows[e.features[0].properties.i]; restrPopup(r); });
    map.on('click', 'route', e => { if (mode !== 'preview') return; e.preventDefault(); avoidPopup(e.lngLat); });
    for (const l of ['restr', 'route']) {
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
      <p class="m"><a href="https://www.openstreetmap.org/${r.et}/${r.id}" target="_blank" rel="noopener">Ver en OpenStreetMap</a></p></div></div>`).addTo(map);
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
    if (!nav) { $('alert').hidden = true; map.easeTo({ pitch: 0, bearing: 0, duration: 400 }); }
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
    if (!meMarker) meMarker = new maplibregl.Marker({ element: meEl(), rotationAlignment: 'map', pitchAlignment: 'viewport' }).setLngLat([me.lon, me.lat]).addTo(map);
    else meMarker.setLngLat([me.lon, me.lat]);
    meMarker.setRotation(me.heading || 0);
    if (mode === 'nav') navTick();
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
    if (key()) return false;
    showErr('Falta la clave de rutas. Tocá el menú ☰ (arriba a la izquierda) y pegala en "Clave de rutas".');
    return true;
  }
  async function geocode(text) {
    const c = me ? { lat: me.lat, lng: me.lon } : map.getCenter();
    const u = `${ORS}/geocode/search?api_key=${encodeURIComponent(key())}&text=${encodeURIComponent(text)}&boundary.country=AR&size=6&focus.point.lat=${c.lat}&focus.point.lon=${c.lng}`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'La clave de rutas no es válida. Revisala en el menú ☰.' : 'El buscador no respondió. Probá de nuevo.');
    const d = await res.json();
    return d.features.map(f => ({ label: f.properties.label.replace(/, Argentina$/, ''), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  }
  async function reverse(lat, lon) {
    try {
      const d = await (await fetch(`${ORS}/geocode/reverse?api_key=${encodeURIComponent(key())}&point.lat=${lat}&point.lon=${lon}&size=1&boundary.country=AR`)).json();
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
        b.innerHTML = `<span class="ico">📍</span><span><span class="t">${esc(first)}</span><br><span class="m">${esc(rest.join(', '))}</span></span><span></span>`;
        b.addEventListener('click', () => goTo(p));
        box.appendChild(b);
      }
      setMode('results');
    } catch (err) { setMode('home'); showErr(err.message); }
  });

  function renderFavs() {
    const box = $('favs'); box.textContent = '';
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
    return avoids.concat(own.map(o => ({ lat: +o.lat, lon: +o.lon })));
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
    const res = await fetch(`${ORS}/v2/directions/driving-hgv/geojson`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key() }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = d.error && d.error.code;
      const e = new Error('El servicio de rutas no respondió. Probá de nuevo en un rato.'); e.code = code;
      if (res.status === 401 || res.status === 403) e.message = 'La clave de rutas no es válida. Revisala en el menú ☰.';
      else if (code === 2004) e.message = 'too-long';
      else if (code === 2010) e.message = 'No hay una calle para camión cerca del punto de salida o de llegada.';
      else if (code === 2009 || code === 2099) e.message = 'No encontré una ruta posible para este camión. Probá con otro destino o revisá las calles evitadas.';
      else if (res.status === 429) e.message = 'Se alcanzó el límite de rutas gratis de hoy. Probá de nuevo mañana.';
      throw e;
    }
    const f = d.features[0];
    return { coords: f.geometry.coordinates.map(([lo, la]) => [la, lo]), steps: f.properties.segments.flatMap(s => s.steps),
      dist: f.properties.summary.distance || 0, dur: f.properties.summary.duration || 0 };
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
    const rt = { from, to, coords: r.coords, cum, steps, total: cum[cum.length - 1], time: r.dur,
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

  async function goTo(place) {
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
    avoids.push({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), label, at: new Date().toISOString().slice(0, 10) });
    store.set('avoids', avoids); drawAvoids();
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
    Object.assign(nav, { idx: 0, spoken: {}, off: 0, overSince: 0 });
    setMode('nav'); requestWake(); startWatch();
    saveTrip(); downloadCorridor(route);
    speak('Vamos. ' + (route.steps[0] ? route.steps[0].text : ''));
    navTick();
  });
  $('b-stop').addEventListener('click', () => {
    try { nav.wake && nav.wake.release(); } catch (e) { /* nada */ }
    try { speechSynthesis.cancel(); } catch (e) { /* nada */ }
    store.set('trip', null);
    clearRoute(); setMode('home');
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
      Object.assign(nav, { idx: 0, spoken: {}, off: 0 });
      hideAlert(); navTick(); saveTrip(); downloadCorridor(rt);
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
    if (!over) { nav.overSince = 0; return; }
    if (!nav.overSince) nav.overSince = Date.now();
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
    const head = (me.speed > 5 && me.heading) ? me.heading : bearing(c[bi], c[Math.min(c.length - 1, bi + 3)]);
    map.easeTo({ center: [me.lon, me.lat], zoom: me.speed > 60 ? 15.5 : 16.5, bearing: head, pitch: 55, duration: 900, offset: [0, innerHeight * 0.18] });

    $('eta-left').textContent = km(left);
    $('eta-time').textContent = `Llegás ${clock(route.time * left / route.total)}`;

    if (best > 60) nav.off++; else nav.off = 0;
    if (nav.off >= 3) { nav.off = 0; showAlert('Recalculando…', 'orange'); speak('Recalculando.'); reroute(false); return; }

    if (left < 30) {
      $('turn-arrow').innerHTML = arrowSVG(10); $('turn-dist').textContent = ''; $('turn-text').textContent = 'Llegaste a destino';
      if (!nav.spoken.end) { nav.spoken.end = 1; speak('Llegaste a destino.'); }
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
      d.innerHTML = `<span class="ico">⛔</span><span><span class="t">${esc(a.label)}</span><br><span class="m">${a.at} · ${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}</span></span><button type="button" class="x" aria-label="Borrar">✕</button>`;
      d.querySelector('.x').addEventListener('click', () => { avoids.splice(i, 1); store.set('avoids', avoids); drawAvoids(); renderAvoids(); });
      box.appendChild(d);
    });
  }
  $('b-menu').addEventListener('click', () => {
    renderTrucks(); renderAvoids();
    $('s-speed').value = speedLimit; $('s-key').value = store.get('key', '') ? '••••••••' : ''; $('s-restr').checked = store.get('showAll', false);
    $('settings').showModal();
  });
  $('s-speed').addEventListener('change', () => { const v = parseInt($('s-speed').value, 10); if (v >= 40 && v <= 130) { speedLimit = v; store.set('speedLimit', v); } });
  for (const ev of ['change', 'input']) $('s-key').addEventListener(ev, () => { const v = $('s-key').value.trim(); if (v.length > 20 && !/^•+$/.test(v)) { store.set('key', v); showErr(''); } });


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
  map.on('styleimagemissing', e => { if (e.id.startsWith('sg|') && !map.hasImage(e.id)) map.addImage(e.id, makeSign(e.id), { pixelRatio: 2 }); });

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
    store.set('trip', { at: Date.now(), from: route.from, to: route.to, coords: route.coords, steps: route.steps, time: route.time });
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
      drawRoute(route);
      $('b-go').click();
    });
    box.prepend(b);
  }

  // ---------- Arranque ----------
  renderTruckChip(); setMode('home');
  Promise.all([
    fetch('data/restricciones.json').then(r => r.json()),
    fetch('data/propias.json').then(r => r.json()).catch(() => []),
  ]).then(([d, own]) => {
    window.__OWN = own;
    rows = d.rows.map(([id, et, pi, loc, street, t, raw, lat, lon, segs]) => {
      const num = parseVal(t, raw);
      return { id, et: et === 'w' ? 'way' : 'node', prov: d.provs[pi], loc, street, t, raw, num, lat, lon, segs,
        dubious: (t in RANGE) && (!Number.isFinite(num) || num < RANGE[t][0] || num > RANGE[t][1]) };
    });
    ready.then(refreshRestr);
  }).catch(() => showErr('No pude cargar las restricciones. Revisá la conexión.'));
  getMe().then(p => map.jumpTo({ center: [p.lon, p.lat], zoom: 14 })).catch(() => {});
})();
