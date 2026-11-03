/* Camiones AR: mapa de restricciones + ruta para camión con OpenRouteService + navegación con GPS. */
(() => {
  'use strict';
  const ORS = 'https://api.openrouteservice.org';
  const $ = id => document.getElementById(id);
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const fmt = n => String(n).replace('.', ',');
  const store = {
    get(k, d) { try { const v = localStorage.getItem('camionesar.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('camionesar.' + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } },
  };

  // ---------- Tipos de restricción ----------
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

  // ---------- Camión ----------
  const DEFAULTS = { h: 4.1, w: 45, l: 20, wd: 2.6, e: 10.5, hz: true };
  const truck = Object.assign({}, DEFAULTS, store.get('truck', {}));
  const tin = { h: $('f-h'), w: $('f-w'), l: $('f-l'), wd: $('f-wd'), e: $('f-e') };
  for (const k in tin) tin[k].value = truck[k];
  $('f-hz').checked = !!truck.hz;
  $('f-key').value = store.get('key', '');

  function verdict(r) {
    if (r.t === 'P') return 'no';
    if (r.t === 'D') return 'warn';
    if (r.t === 'H') return truck.hz ? 'no' : 'ok';
    if (r.dubious) return 'dud';
    const lim = { A: truck.h, W: truck.w, L: truck.l, E: truck.e }[r.t];
    if (r.num < lim) return 'no';
    if (r.t === 'A' && r.num - lim < 0.2) return 'warn';
    return 'ok';
  }
  const VTXT = { no: 'No pasa', warn: 'Solo con destino', ok: 'Pasa', dud: 'Dato dudoso' };
  const vlabel = r => (r.v === 'warn' && r.t === 'A') ? 'Al límite' : VTXT[r.v];
  const VCLS = { no: 'v-no', warn: 'v-warn', ok: 'v-ok', dud: 'v-dud' };
  const TRUCK_SVG = '<svg viewBox="0 0 24 24" fill="#111"><path d="M2 7h11v8H2zM13 10h4l3 3v2h-7zM4 17.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M14 17.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0"/></svg>';
  function signHTML(r, sm) {
    const c = 'sign' + (sm ? ' sm' : '');
    if (r.t === 'P' || r.t === 'D') return `<div class="${c} slash" aria-hidden="true">${TRUCK_SVG}</div>`;
    if (r.t === 'H') return `<div class="${c} slash" aria-hidden="true" style="font-size:${sm ? 9 : 11}px">ONU</div>`;
    return `<div class="${c}" aria-hidden="true">${Number.isFinite(r.num) ? fmt(r.num) : '?'}</div>`;
  }
  function describe(r) {
    const T = TYPES[r.t];
    if (r.t === 'P') return 'Prohibido el paso de camiones';
    if (r.t === 'D') return 'Camiones solo con destino en la zona';
    if (r.t === 'H') return 'Prohibido para cargas peligrosas';
    if (r.dubious) return `${T.name}: "${esc(r.raw)}" (valor mal cargado)`;
    return `${T.name}: ${fmt(r.num)} ${T.unit}`;
  }

  // ---------- Mapa ----------
  const map = L.map('map', { preferCanvas: true, zoomControl: true, minZoom: 4, maxZoom: 19 });
  map.attributionControl.setPrefix(false);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">colaboradores de OpenStreetMap</a>',
  }).addTo(map);
  const renderer = L.canvas({ padding: 0.3 });
  const pointLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const AMBA = [[-34.95, -58.85], [-34.35, -58.2]];
  map.fitBounds(AMBA);

  // ---------- Datos ----------
  let rows = [];
  let OWN = [];
  const active = new Set(Object.keys(TYPES));
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let visible = [];

  async function loadData() {
    const [d, own] = await Promise.all([
      fetch('data/restricciones.json').then(r => r.json()),
      fetch('data/propias.json').then(r => r.json()).catch(() => []),
    ]);
    rows = d.rows.map(([id, et, pi, loc, street, t, raw, lat, lon, segs]) => {
      const num = parseVal(t, raw);
      const dubious = (t in RANGE) && (!Number.isFinite(num) || num < RANGE[t][0] || num > RANGE[t][1]);
      return { id, et: et === 'w' ? 'way' : 'node', prov: d.provs[pi], loc, street, t, raw, num, lat, lon, segs, dubious };
    });
    OWN = own;
    const counts = {};
    rows.forEach(r => { counts[r.t] = (counts[r.t] || 0) + 1; });
    for (const [k, T] of Object.entries(TYPES)) {
      if (!counts[k]) { active.delete(k); continue; }
      const lab = document.createElement('label');
      lab.className = 'chip'; lab.style.setProperty('--c', `var(${T.color})`);
      lab.innerHTML = `<input type="checkbox" checked><span class="dot"></span>${T.name} <small>${counts[k]}</small>`;
      lab.querySelector('input').addEventListener('change', e => { e.target.checked ? active.add(k) : active.delete(k); render(); });
      $('chips').appendChild(lab);
    }
    d.provs.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; $('f-prov').appendChild(o); });
    $('own-n').textContent = OWN.length;
    for (const o of OWN) {
      const a = document.createElement('article');
      a.innerHTML = `<div class="t">${esc(o.lugar)}</div><div class="m">${esc([o.tipo, o.limite].filter(Boolean).join(' · '))}${o.horario ? ' · ' + esc(o.horario) : ''}</div><div class="m">${esc([o.loc, o.prov].filter(Boolean).join(', '))} · ${esc(o.estado)}</div>`;
      $('own').appendChild(a);
    }
    render();
  }

  function render() {
    const only = $('f-only').checked, prov = $('f-prov').value, q = norm($('f-q').value.trim());
    let aff = 0; visible = [];
    pointLayer.clearLayers();
    for (const r of rows) {
      r.v = verdict(r);
      if (r.v === 'no' || r.v === 'warn') aff++;
      if (!active.has(r.t)) continue;
      if (only && !(r.v === 'no' || r.v === 'warn')) continue;
      if (prov && r.prov !== prov) continue;
      if (q && !norm(r.street + ' ' + r.loc).includes(q)) continue;
      visible.push(r);
      const col = (r.v === 'ok' || r.v === 'dud') ? css('--t-ok') : css(TYPES[r.t].color);
      L.circleMarker([r.lat, r.lon], { renderer, radius: r.v === 'no' ? 6 : 4.5, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: .95 })
        .on('click', ev => { L.DomEvent.stopPropagation(ev); openPop(r); }).addTo(pointLayer);
    }
    $('n-aff').textContent = aff.toLocaleString('es-AR');
    $('n-txt').textContent = `de ${rows.length.toLocaleString('es-AR')} restricciones afectan a tu camión`;
    renderList();
  }

  function openPop(r) {
    L.popup({ maxWidth: 320 }).setLatLng([r.lat, r.lon]).setContent(`<div class="pop">${signHTML(r)}<div>
      <h3>${esc(r.street)}</h3>
      <p><span class="verdict ${VCLS[r.v]}">${vlabel(r)}</span>${describe(r)}</p>
      <p class="m">${esc([r.loc, r.prov].filter(Boolean).join(', '))}${r.segs > 1 ? ` · ${r.segs} tramos` : ''}</p>
      <p class="m"><a href="https://www.openstreetmap.org/${r.et}/${r.id}" target="_blank" rel="noopener">Ver en OpenStreetMap</a> · ${TYPES[r.t].key}=${esc(r.raw)}</p>
    </div></div>`).openOn(map);
  }

  const ORDER = { no: 0, warn: 1, dud: 2, ok: 3 }, TORD = 'PHADWLE';
  const LIMIT = () => matchMedia('(max-width: 760px)').matches ? 20 : 60;
  function renderList() {
    const b = map.getBounds();
    const inView = visible.filter(r => b.contains([r.lat, r.lon]))
      .sort((a, c) => ORDER[a.v] - ORDER[c.v] || TORD.indexOf(a.t) - TORD.indexOf(c.t) || c.segs - a.segs || a.street.localeCompare(c.street));
    const box = $('list'); box.textContent = '';
    for (const r of inView.slice(0, LIMIT())) {
      const it = document.createElement('button');
      it.type = 'button'; it.className = 'item';
      it.innerHTML = `${signHTML(r, true)}<div><div class="t">${esc(r.street)}</div><div class="m"><span class="verdict ${VCLS[r.v]}">${vlabel(r)}</span>${describe(r)} · ${esc(r.loc || r.prov)}</div></div>`;
      it.addEventListener('click', () => { map.setView([r.lat, r.lon], Math.max(map.getZoom(), 15)); openPop(r); });
      box.appendChild(it);
    }
    $('more').textContent = inView.length === 0 ? 'No hay restricciones en esta zona con los filtros actuales.'
      : inView.length > LIMIT() ? `Mostrando ${LIMIT()} de ${inView.length.toLocaleString('es-AR')}. Acercá el mapa para ver el resto.` : `${inView.length} en esta zona.`;
  }

  // ---------- Pestañas ----------
  const tabs = ['viaje', 'camion', 'mapa'];
  function showTab(name) {
    for (const t of tabs) { $('t-' + t).setAttribute('aria-selected', String(t === name)); $('p-' + t).hidden = t !== name; }
    store.set('tab', name);
  }
  tabs.forEach(t => $('t-' + t).addEventListener('click', () => showTab(t)));
  showTab(store.get('tab', 'viaje'));

  // ---------- Búsqueda de direcciones ----------
  const key = () => $('f-key').value.trim();
  function needKey() {
    if (key()) return false;
    showErr('Falta la clave de rutas. Cargala en "Mi camión" para buscar direcciones y armar rutas.');
    showTab('camion'); $('f-key').focus();
    return true;
  }
  function showErr(msg) { const e = $('err'); e.textContent = msg; e.hidden = !msg; }

  const places = { from: null, to: null };
  const markers = { from: null, to: null };
  function setPlace(which, p) {
    places[which] = p;
    $('q-' + which).value = p ? p.label : '';
    if (markers[which]) { markers[which].remove(); markers[which] = null; }
    if (p && !(which === 'from' && p.gps)) {
      markers[which] = L.circleMarker([p.lat, p.lon], { radius: 9, color: '#fff', weight: 3, fillColor: which === 'to' ? css('--t-p') : css('--route'), fillOpacity: 1 })
        .bindTooltip(which === 'to' ? 'Destino' : 'Salida').addTo(map);
    }
  }

  async function geocode(text) {
    const c = map.getCenter();
    const u = `${ORS}/geocode/search?api_key=${encodeURIComponent(key())}&text=${encodeURIComponent(text)}&boundary.country=AR&size=6&focus.point.lat=${c.lat}&focus.point.lon=${c.lng}`;
    const res = await fetch(u);
    if (!res.ok) throw new Error(res.status === 403 || res.status === 401 ? 'La clave de rutas no es válida.' : `El buscador respondió con error ${res.status}.`);
    const d = await res.json();
    return d.features.map(f => ({ label: f.properties.label.replace(/, Argentina$/, ''), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));
  }
  async function reverse(lat, lon) {
    try {
      const res = await fetch(`${ORS}/geocode/reverse?api_key=${encodeURIComponent(key())}&point.lat=${lat}&point.lon=${lon}&size=1&boundary.country=AR`);
      const d = await res.json();
      return d.features[0].properties.label.replace(/, Argentina$/, '');
    } catch (e) { return `${lat.toFixed(5)}, ${lon.toFixed(5)}`; }
  }

  function wireSearch(which) {
    const inp = $('q-' + which), box = $('r-' + which);
    inp.addEventListener('keydown', async e => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = inp.value.trim();
      if (text.length < 3 || needKey()) return;
      box.hidden = false; box.innerHTML = '<button type="button" disabled>Buscando…</button>';
      try {
        const res = await geocode(text);
        box.textContent = '';
        if (!res.length) { box.innerHTML = '<button type="button" disabled>No encontré esa dirección. Probá con calle, número y ciudad.</button>'; return; }
        for (const p of res) {
          const b = document.createElement('button'); b.type = 'button';
          const [first, ...rest] = p.label.split(', ');
          b.innerHTML = `${esc(first)}<small>${esc(rest.join(', '))}</small>`;
          b.addEventListener('click', () => { setPlace(which, p); box.hidden = true; map.setView([p.lat, p.lon], 14); });
          box.appendChild(b);
        }
      } catch (err) { box.hidden = true; showErr(err.message); }
    });
    inp.addEventListener('input', () => { if (places[which] && inp.value !== places[which].label) places[which] = null; });
  }
  wireSearch('from'); wireSearch('to');

  // ---------- GPS ----------
  let me = null, meMarker = null, watchId = null;
  const meIcon = L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] });
  function updateMe(pos) {
    me = { lat: pos.coords.latitude, lon: pos.coords.longitude, acc: pos.coords.accuracy, speed: pos.coords.speed, at: Date.now() };
    if (!meMarker) meMarker = L.marker([me.lat, me.lon], { icon: meIcon, interactive: false, zIndexOffset: 1000 }).addTo(map);
    else meMarker.setLatLng([me.lat, me.lon]);
    if (nav.on) navTick();
  }
  function startWatch() {
    if (watchId != null || !('geolocation' in navigator)) return;
    watchId = navigator.geolocation.watchPosition(updateMe, err => {
      if (err.code === 1) showErr('El celular no dio permiso de ubicación. Habilitalo en la configuración del navegador.');
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }
  function getOnce() {
    if (me && Date.now() - me.at < 30000) { startWatch(); return Promise.resolve(me); }
    return new Promise((ok, fail) => {
      if (!('geolocation' in navigator)) return fail(new Error('Este dispositivo no tiene GPS disponible.'));
      navigator.geolocation.getCurrentPosition(p => { updateMe(p); startWatch(); ok(me); },
        e => fail(new Error(e.code === 1 ? 'El celular no dio permiso de ubicación.' : 'No pude obtener tu ubicación.')),
        { enableHighAccuracy: true, timeout: 20000 });
    });
  }
  $('b-gps').addEventListener('click', async () => {
    showErr('');
    try { const p = await getOnce(); setPlace('from', { label: 'Mi ubicación', lat: p.lat, lon: p.lon, gps: true }); map.setView([p.lat, p.lon], 15); }
    catch (e) { showErr(e.message); }
  });

  // Tocar el mapa para elegir destino (en la pestaña Viaje)
  map.on('click', async e => {
    if ($('p-viaje').hidden || nav.on) return;
    const { lat, lng } = e.latlng;
    const html = document.createElement('div');
    html.innerHTML = `<p style="margin:0 0 6px">¿Ir hasta acá?</p><div class="btns"><button type="button" class="primary">Elegir como destino</button><button type="button">Salir desde acá</button></div>`;
    const [bTo, bFrom] = html.querySelectorAll('button');
    const pop = L.popup().setLatLng(e.latlng).setContent(html).openOn(map);
    const pick = async which => { map.closePopup(pop); setPlace(which, { label: 'Punto en el mapa', lat, lon: lng }); if (key()) setPlace(which, { label: await reverse(lat, lng), lat, lon: lng }); };
    bTo.addEventListener('click', () => pick('to'));
    bFrom.addEventListener('click', () => pick('from'));
  });

  // ---------- Ruta para camión ----------
  let route = null;
  function avoidPolygons() {
    // Filas propias con coordenadas: cuadrado de ~60 m a esquivar.
    const polys = OWN.filter(o => Number.isFinite(+o.lat) && Number.isFinite(+o.lon) && o.lat !== '' && /prohib|altura|peso|peligros/i.test(o.tipo || '')).map(o => {
      const d = 0.0003, la = +o.lat, lo = +o.lon;
      return [[[lo - d, la - d], [lo + d, la - d], [lo + d, la + d], [lo - d, la + d], [lo - d, la - d]]];
    });
    return polys.length ? { type: 'MultiPolygon', coordinates: polys } : null;
  }

  async function requestRoute(from, to) {
    const body = {
      coordinates: [[from.lon, from.lat], [to.lon, to.lat]],
      language: 'es', instructions: true, units: 'm',
      options: { vehicle_type: 'hgv', profile_params: { restrictions: {
        height: truck.h, weight: truck.w, length: truck.l, width: truck.wd, axleload: truck.e, hazmat: !!truck.hz } } },
    };
    const av = avoidPolygons(); if (av) body.options.avoid_polygons = av;
    const res = await fetch(`${ORS}/v2/directions/driving-hgv/geojson`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: key() }, body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const code = d.error && d.error.code;
      if (res.status === 401 || res.status === 403) throw new Error('La clave de rutas no es válida.');
      if (code === 2010) throw new Error('El punto de salida o de llegada está lejos de una calle por donde pueda ir un camión. Elegí un punto sobre una calle.');
      if (code === 2009 || code === 2099) throw new Error('No encontré una ruta posible para tu camión con esas medidas.');
      if (res.status === 429) throw new Error('Se alcanzó el límite diario de rutas gratis. Probá de nuevo mañana.');
      throw new Error((d.error && d.error.message) || `El servicio de rutas respondió con error ${res.status}.`);
    }
    const f = d.features[0];
    const coords = f.geometry.coordinates.map(([lo, la]) => [la, lo]);
    const steps = f.properties.segments.flatMap(s => s.steps);
    const cum = [0];
    for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + dist(coords[i - 1], coords[i]));
    return { coords, steps, cum, summary: f.properties.summary, to };
  }

  function dist(a, b) { // metros, aproximación equirectangular (suficiente para tramos cortos)
    const R = 6371000, toR = Math.PI / 180, x = (b[1] - a[1]) * toR * Math.cos((a[0] + b[0]) / 2 * toR), y = (b[0] - a[0]) * toR;
    return Math.sqrt(x * x + y * y) * R;
  }
  function distToSeg(p, a, b) { // metros desde p al segmento ab, y fracción t
    const toR = Math.PI / 180, k = Math.cos(p[0] * toR) * 111320, m = 110540;
    const ax = (a[1] - p[1]) * k, ay = (a[0] - p[0]) * m, bx = (b[1] - p[1]) * k, by = (b[0] - p[0]) * m;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? -(ax * dx + ay * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
    const x = ax + t * dx, y = ay + t * dy;
    return { d: Math.sqrt(x * x + y * y), t };
  }

  function nearRoute(rt, maxM) {
    let minLa = 90, maxLa = -90, minLo = 180, maxLo = -180;
    for (const [la, lo] of rt.coords) { minLa = Math.min(minLa, la); maxLa = Math.max(maxLa, la); minLo = Math.min(minLo, lo); maxLo = Math.max(maxLo, lo); }
    const pad = 0.002, out = [];
    for (const r of rows) {
      if (r.v !== 'no' && r.v !== 'warn') continue;
      if (r.lat < minLa - pad || r.lat > maxLa + pad || r.lon < minLo - pad || r.lon > maxLo + pad) continue;
      let best = Infinity, at = 0;
      for (let i = 1; i < rt.coords.length; i++) {
        const s = distToSeg([r.lat, r.lon], rt.coords[i - 1], rt.coords[i]);
        if (s.d < best) { best = s.d; at = rt.cum[i - 1] + s.t * (rt.cum[i] - rt.cum[i - 1]); }
      }
      if (best <= maxM) out.push({ r, d: best, at });
    }
    return out.sort((a, b) => a.at - b.at);
  }

  const km = m => m >= 1000 ? `${fmt((m / 1000).toFixed(m >= 10000 ? 0 : 1))} km` : `${Math.round(m / 10) * 10} m`;
  const hm = s => { const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h} h ${m} min` : `${m} min`; };

  function drawRoute(rt) {
    routeLayer.clearLayers();
    L.polyline(rt.coords, { color: '#fff', weight: 9, opacity: .9, interactive: false }).addTo(routeLayer);
    L.polyline(rt.coords, { color: css('--route'), weight: 5, opacity: 1, interactive: false }).addTo(routeLayer);
  }

  function showRoute(rt) {
    route = rt;
    drawRoute(rt);
    $('route-out').hidden = false;
    $('summary').innerHTML = `<div><b>${km(rt.summary.distance)}</b></div><div><b>${hm(rt.summary.duration)}</b></div><span>Ruta para camión de ${fmt(truck.h)} m, ${fmt(truck.w)} t y ${fmt(truck.l)} m${truck.hz ? ', con carga peligrosa' : ''}.</span>`;
    const near = nearRoute(rt, 25);
    rt.near = near;
    const w = $('warns'); w.textContent = '';
    if (!near.length) w.innerHTML = '<p class="ok">No encontré restricciones de la base sobre este recorrido.</p>';
    else {
      const h = document.createElement('p'); h.className = 'hint';
      h.textContent = `Revisá ${near.length === 1 ? 'este punto' : `estos ${near.length} puntos`} cerca del recorrido (a menos de 25 m):`;
      w.appendChild(h);
      for (const n of near.slice(0, 15)) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'warn';
        b.innerHTML = `${signHTML(n.r, true)}<div><div class="t">${esc(n.r.street)}</div><div class="m"><span class="verdict ${VCLS[n.r.v]}">${vlabel(n.r)}</span>${describe(n.r)} · a ${km(n.at)} de la salida</div></div>`;
        b.addEventListener('click', () => { map.setView([n.r.lat, n.r.lon], 17); openPop(n.r); });
        w.appendChild(b);
      }
    }
    const ol = $('steps'); ol.textContent = '';
    for (const s of rt.steps) { const li = document.createElement('li'); li.innerHTML = `${esc(s.instruction)} <span>${s.distance ? km(s.distance) : ''}</span>`; ol.appendChild(li); }
  }

  $('f-route').addEventListener('submit', async e => {
    e.preventDefault(); showErr('');
    if (needKey()) return;
    const btn = $('b-route');
    try {
      btn.disabled = true; btn.textContent = 'Armando ruta…';
      let from = places.from;
      if (!from) { const p = await getOnce(); from = { label: 'Mi ubicación', lat: p.lat, lon: p.lon, gps: true }; setPlace('from', from); }
      if (!places.to) throw new Error('Elegí un destino: buscalo y tocá el resultado, o tocá el mapa.');
      const rt = await requestRoute(from, places.to);
      showRoute(rt);
      map.fitBounds(L.latLngBounds(rt.coords).pad(0.1));
    } catch (err) { showErr(err.message); }
    finally { btn.disabled = false; btn.textContent = 'Armar ruta para mi camión'; }
  });
  $('b-clear').addEventListener('click', () => { route = null; routeLayer.clearLayers(); $('route-out').hidden = true; setPlace('to', null); });

  // ---------- Navegación ----------
  const nav = { on: false, idx: 0, spoken: {}, off: 0, lastReroute: 0, wake: null };
  function say(text) {
    try { if (!('speechSynthesis' in window)) return; const u = new SpeechSynthesisUtterance(text); u.lang = 'es-AR'; speechSynthesis.cancel(); speechSynthesis.speak(u); } catch (e) { /* sin voz */ }
  }
  async function startNav() {
    if (!route) return;
    try { await getOnce(); } catch (e) { showErr(e.message); return; }
    nav.on = true; nav.idx = 0; nav.spoken = {}; nav.off = 0;
    document.body.classList.add('navigating');
    $('nav-banner').hidden = false;
    setTimeout(() => map.invalidateSize(), 50);
    requestWake();
    say('Iniciando ruta para camión. ' + (route.steps[0] ? route.steps[0].instruction : ''));
    navTick();
  }
  function stopNav() {
    nav.on = false; document.body.classList.remove('navigating'); $('nav-banner').hidden = true;
    try { nav.wake && nav.wake.release(); } catch (e) { /* nada */ }
    try { speechSynthesis.cancel(); } catch (e) { /* nada */ }
    setTimeout(() => map.invalidateSize(), 50);
  }
  $('b-nav').addEventListener('click', startNav);
  $('b-stop').addEventListener('click', stopNav);
  // Mantener la pantalla prendida mientras se navega (sin esperar: algunos celulares no responden nunca)
  function requestWake() {
    try { navigator.wakeLock.request('screen').then(w => { nav.wake = w; w.addEventListener('release', () => { nav.wake = null; }); }).catch(() => {}); } catch (e) { /* sin soporte */ }
  }
  document.addEventListener('visibilitychange', () => { if (nav.on && document.visibilityState === 'visible' && !nav.wake) requestWake(); });

  async function navTick() {
    if (!nav.on || !me || !route) return;
    const p = [me.lat, me.lon], c = route.coords;
    // buscar el punto más cercano del recorrido cerca de la última posición conocida
    let best = Infinity, bi = nav.idx, bt = 0;
    const from = Math.max(1, nav.idx - 20), to = Math.min(c.length - 1, nav.idx + 400);
    for (let i = from; i <= to; i++) { const s = distToSeg(p, c[i - 1], c[i]); if (s.d < best) { best = s.d; bi = i - 1; bt = s.t; } }
    nav.idx = bi;
    const done = route.cum[bi] + bt * (route.cum[bi + 1] - route.cum[bi]);
    const left = route.summary.distance - done;
    map.setView(p, Math.max(map.getZoom(), 16), { animate: true });

    // fuera de ruta: recalcular
    if (best > 60) nav.off++; else nav.off = 0;
    if (nav.off >= 3 && Date.now() - nav.lastReroute > 30000) {
      nav.lastReroute = Date.now(); nav.off = 0;
      say('Recalculando ruta.');
      try { const rt = await requestRoute({ label: 'Mi ubicación', lat: me.lat, lon: me.lon, gps: true }, route.to); showRoute(rt); nav.idx = 0; nav.spoken = {}; }
      catch (e) { $('nb-meta').textContent = e.message; }
      return;
    }
    if (left < 30) { $('nb-dist').textContent = '✓'; $('nb-text').textContent = 'Llegaste a destino'; $('nb-meta').textContent = ''; if (!nav.spoken.end) { nav.spoken.end = 1; say('Llegaste a destino.'); } return; }

    // próxima maniobra: el primer paso cuyo comienzo esté por delante
    let si = route.steps.findIndex(s => s.way_points[0] > bi);
    if (si < 0) si = route.steps.length - 1;
    const step = route.steps[si];
    const toStep = Math.max(0, route.cum[step.way_points[0]] - done);
    $('nb-dist').textContent = km(toStep);
    $('nb-text').textContent = step.instruction;
    const nextWarn = (route.near || []).find(n => n.at > done);
    $('nb-meta').textContent = `Faltan ${km(left)}` + (nextWarn ? ` · Ojo en ${km(nextWarn.at - done)}: ${nextWarn.r.street} (${vlabel(nextWarn.r).toLowerCase()})` : '');
    for (const [th, pre] of [[600, 'En 500 metros, '], [200, 'En 200 metros, '], [40, '']]) {
      const k = si + ':' + th;
      if (toStep <= th && !nav.spoken[k]) { nav.spoken[k] = 1; say(pre + step.instruction); break; }
    }
    if (nextWarn && nextWarn.at - done < 400 && !nav.spoken['w' + nextWarn.r.id + nextWarn.r.t]) {
      nav.spoken['w' + nextWarn.r.id + nextWarn.r.t] = 1;
      say(`Atención: adelante hay una restricción. ${describe(nextWarn.r).replace(/\(.*\)/, '')}.`);
    }
  }

  // ---------- Eventos de filtros y camión ----------
  function saveTruck() {
    for (const k in tin) { const v = parseFloat(String(tin[k].value).replace(',', '.')); if (Number.isFinite(v)) truck[k] = v; }
    truck.hz = $('f-hz').checked;
    store.set('truck', truck);
    render();
  }
  for (const k in tin) tin[k].addEventListener('input', saveTruck);
  $('f-hz').addEventListener('change', saveTruck);
  $('f-key').addEventListener('change', () => { store.set('key', $('f-key').value.trim()); showErr(''); });
  $('f-only').addEventListener('change', render);
  $('f-prov').addEventListener('change', () => {
    render();
    const pts = visible.map(r => [r.lat, r.lon]);
    if ($('f-prov').value && pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 13 });
  });
  let qt; $('f-q').addEventListener('input', () => { clearTimeout(qt); qt = setTimeout(render, 200); });
  map.on('moveend', renderList);

  // ---------- Instalar como app ----------
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('b-install').hidden = false; });
  $('b-install').addEventListener('click', async () => { if (!installEvt) return; installEvt.prompt(); await installEvt.userChoice; installEvt = null; $('b-install').hidden = true; });
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});

  loadData().catch(() => showErr('No pude cargar las restricciones. Revisá la conexión y recargá la página.'));
})();
