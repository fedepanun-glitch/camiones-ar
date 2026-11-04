/* Camiones AR — panel del dueño: choferes, camiones, lugares, viajes, ubicación en vivo, alertas y calles marcadas. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => String(n ?? '').replace('.', ',');
  const N = window.Nube;
  const STALE_MS = 10 * 60 * 1000;
  const TRUCK_SVG = '<svg viewBox="0 0 24 24" fill="#fff" aria-hidden="true"><path d="M2 7h11v8H2zM13 10h4l3 3v2h-7zM4 17.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0M14 17.5a1.6 1.6 0 1 0 3.2 0 1.6 1.6 0 1 0-3.2 0"/></svg>';
  const TIPO = { base: ['🏠', 'Base'], cliente: ['🏭', 'Cliente'], deposito: ['📦', 'Depósito'], otro: ['📍', 'Otro'] };
  const ESTADO = { pendiente: 'Pendiente', en_curso: 'En curso', terminado: 'Terminado', cancelado: 'Cancelado' };

  if (!N || !N.configurada) { $('no-cloud').hidden = false; return; }
  const sb = N.sb;

  // ---------- Datos ----------
  const D = { choferes: [], camiones: [], lugares: [], viajes: [], posiciones: [], alertas: [], bloqueos: [], rastreo: [], sitrack: null, ajustes: { velocidad_max: 80 } };
  const byId = (arr, id) => arr.find(x => x.id === id);
  // El dueño también puede manejar o probar la app: aparece como "Yo" en la lista de choferes
  const chofer = id => byId(D.choferes, id) || (me && me.id === id ? { ...me, nombre: `${me.nombre} (yo)` } : null);
  const camion = id => byId(D.camiones, id);
  const lugar = id => byId(D.lugares, id);
  // Direcciones de un solo viaje (no guardadas en Lugares): existen para el viaje pero no se listan
  const VIAJE_PREF = 'Viaje · ';
  const guardados = () => D.lugares.filter(l => !String(l.nombre).startsWith(VIAJE_PREF));

  let toastT;
  function toast(text, red) { const t = $('toast'); t.textContent = text; t.className = 'toast' + (red ? ' red' : ''); t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 5000); }
  const fail = (e, what) => { console.warn(e); toast(`${what}: ${e && e.message ? e.message : 'error'}`, true); };
  async function q(p, what) { const { data, error } = await p; if (error) { fail(error, what); throw error; } return data; }

  const hace = iso => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'recién'; if (s < 3600) return `hace ${Math.round(s / 60)} min`;
    if (s < 86400) return `hace ${Math.round(s / 3600)} h`; return new Date(iso).toLocaleDateString('es-AR');
  };
  const hoyISO = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
  const fechaTxt = f => new Date(f + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'numeric' });

  async function loadAll() {
    const desde = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    const [ch, ca, lu, vi, po, al, bl, aj, ra, st] = await Promise.all([
      sb.from('perfiles').select('*').eq('rol', 'chofer').order('nombre'),
      sb.from('camiones').select('*').order('nombre'),
      sb.from('lugares').select('*').order('nombre'),
      sb.from('viajes').select('*').or(`fecha.gte.${desde},estado.in.(pendiente,en_curso)`).order('fecha', { ascending: false }).order('creado', { ascending: false }),
      sb.from('posiciones').select('*'),
      sb.from('alertas').select('*').order('at', { ascending: false }).limit(60),
      sb.from('bloqueos').select('*').eq('activo', true).order('creado', { ascending: false }),
      sb.from('ajustes').select('*').eq('id', 1).maybeSingle(),
      sb.from('rastreo').select('*'),
      sb.from('sitrack_estado').select('*').eq('id', 1).maybeSingle(),
    ]);
    if (!ra.error) D.rastreo = ra.data;          // si todavía no está la parte de Sitrack, se ignora
    if (!st.error) D.sitrack = st.data;
    const ad = await sb.from('perfiles').select('*').in('rol', ['dueno', 'admin']).order('nombre');
    if (!ad.error) D.admins = ad.data;
    const ev = await sb.from('eventos').select('*').gte('at', inicioDia(hoyISO())).order('at', { ascending: false }).limit(100);
    if (!ev.error) D.eventos = ev.data;
    for (const [k, r] of Object.entries({ choferes: ch, camiones: ca, lugares: lu, viajes: vi, posiciones: po, alertas: al, bloqueos: bl })) {
      if (r.error) fail(r.error, 'No se pudo cargar ' + k); else D[k] = r.data;
    }
    if (!aj.error && aj.data) D.ajustes = aj.data;
    renderAll();
  }

  // ---------- Pestañas ----------
  let tab = 'vivo';
  document.querySelectorAll('.tabs [data-tab]').forEach(b => b.addEventListener('click', () => {
    tab = b.dataset.tab;
    document.querySelectorAll('.tabs [data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === b)));
    document.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== tab; });
    if (tab !== 'lugares' && tab !== 'calles') stopPick();
  }));

  // ---------- Mapa ----------
  const map = new maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/liberty', center: [-58.6, -34.5], zoom: 9, attributionControl: false });
  map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: '© colaboradores de OpenStreetMap (ODbL)' }), 'bottom-right');
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  let styleOk = false, fellBack = false;
  map.on('style.load', () => { styleOk = true; addLayers(); });
  const fallback = () => { if (fellBack || styleOk) return; fellBack = true; map.setStyle({ version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, maxzoom: 19 } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] }); };
  map.on('error', () => { if (!styleOk) fallback(); });
  setTimeout(fallback, 10000);
  const EMPTY = { type: 'FeatureCollection', features: [] };
  function addLayers() {
    if (map.getSource('bloqueos')) return;
    // Rutas: las que siguen los choferes ahora (azul) y la de un viaje elegido en la lista (verde, punteada si es planeada)
    map.addSource('rutas', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'rutas-borde', type: 'line', source: 'rutas', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7 } });
    map.addLayer({ id: 'rutas', type: 'line', source: 'rutas', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1f6feb', 'line-width': 4 } });
    map.addSource('plan', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'plan-borde', type: 'line', source: 'plan', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 8 } });
    map.addLayer({ id: 'plan', type: 'line', source: 'plan', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#12873e', 'line-width': 5 } });
    map.addSource('historial', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'historial-borde', type: 'line', source: 'historial', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 7 } });
    map.addLayer({ id: 'historial', type: 'line', source: 'historial', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#d9480f', 'line-width': 4 } });
    map.addSource('radares', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'radares', type: 'circle', source: 'radares', minzoom: 7, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 3, 14, 7], 'circle-color': '#1d3f9a', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2 } });
    map.addSource('bloqueos', { type: 'geojson', data: EMPTY });
    map.addLayer({ id: 'bloqueos', type: 'circle', source: 'bloqueos', paint: { 'circle-radius': 8, 'circle-color': '#e07a00', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } });
    drawBloqueos(); drawRutas(); drawCams();
  }
  map.on('click', 'radares', e => { if (picking) return; const r = byId(D.radares, e.features[0].properties.id); if (r) camPopup(r); });
  function drawRutas() {
    const s = map.getSource && map.getSource('rutas'); if (!s) return;
    s.setData({ type: 'FeatureCollection', features: D.posiciones.filter(p => p.ruta && p.ruta.coordinates && p.ruta.coordinates.length > 1 && !isStale(p))
      .map(p => ({ type: 'Feature', geometry: p.ruta, properties: { chofer: p.chofer_id } })) });
  }
  map.on('click', 'rutas', e => {
    const p = D.posiciones.find(x => x.chofer_id === e.features[0].properties.chofer); if (!p) return;
    new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`<b>${esc(posLabel(p).who)}</b><br>Va a ${esc(p.destino || 'destino')}`).addTo(map);
  });
  function showPlan(v) {
    const s = map.getSource && map.getSource('plan'); if (!s || !v.ruta) return;
    s.setData({ type: 'Feature', geometry: v.ruta, properties: {} });
    map.setPaintProperty('plan', 'line-dasharray', v.ruta_origen === 'chofer' ? [1, 0] : [2, 1.5]);
    const c = v.ruta.coordinates, lo = c.map(x => x[0]), la = c.map(x => x[1]);
    map.fitBounds([[Math.min(...lo), Math.min(...la)], [Math.max(...lo), Math.max(...la)]], { padding: 60, duration: 700 });
  }
  map.on('click', 'bloqueos', e => {
    const b = byId(D.bloqueos, e.features[0].properties.id); if (!b) return;
    new maplibregl.Popup().setLngLat([b.lon, b.lat]).setHTML(`<b>⛔ ${esc(b.calle || 'Calle sin nombre')}</b><br><span>${esc(quien(b.creado_por))} · ${hace(b.creado)}</span>`).addTo(map);
  });
  function drawBloqueos() {
    const s = map.getSource && map.getSource('bloqueos');
    if (s) s.setData({ type: 'FeatureCollection', features: D.bloqueos.map(b => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [b.lon, b.lat] }, properties: { id: b.id } })) });
  }
  const fly = (lon, lat, z = 15) => map.flyTo({ center: [lon, lat], zoom: z, duration: 700 });

  // Camiones en vivo (un marcador por chofer)
  const truckMarkers = new Map();
  const isOver = p => p.velocidad != null && p.velocidad > D.ajustes.velocidad_max && Date.now() - new Date(p.at).getTime() < 2 * 60 * 1000;
  const isStale = p => Date.now() - new Date(p.at).getTime() > STALE_MS;
  function posLabel(p) { const c = chofer(p.chofer_id), t = camion(p.camion_id); return { who: c ? c.nombre : 'Chofer', truck: t ? t.nombre : '' }; }
  function drawTrucks() {
    const seen = new Set();
    for (const p of D.posiciones) {
      seen.add(p.chofer_id);
      let m = truckMarkers.get(p.chofer_id);
      if (!m) {
        const el = document.createElement('div'); el.className = 'truck';
        el.innerHTML = `<div class="dot">${TRUCK_SVG}</div><div class="lbl"></div>`;
        el.addEventListener('click', ev => { ev.stopPropagation(); truckPopup(p.chofer_id); });
        m = new maplibregl.Marker({ element: el, anchor: 'top' }).setLngLat([p.lon, p.lat]).addTo(map);
        truckMarkers.set(p.chofer_id, m);
      }
      m.setLngLat([p.lon, p.lat]);
      const el = m.getElement(), L = posLabel(p);
      el.classList.toggle('over', isOver(p)); el.classList.toggle('stale', isStale(p));
      el.querySelector('.lbl').textContent = `${L.who} · ${Math.round(p.velocidad || 0)} km/h`;
      el.setAttribute('aria-label', `${L.who}, ${L.truck}, ${Math.round(p.velocidad || 0)} km/h`);
    }
    for (const [id, m] of truckMarkers) if (!seen.has(id)) { m.remove(); truckMarkers.delete(id); }
  }
  function truckPopup(choferId) {
    const p = D.posiciones.find(x => x.chofer_id === choferId); if (!p) return;
    const L = posLabel(p), v = p.viaje_id && byId(D.viajes, p.viaje_id), d = v && lugar(v.destino_id);
    new maplibregl.Popup({ offset: 10 }).setLngLat([p.lon, p.lat]).setHTML(`<b>${esc(L.who)}</b>${L.truck ? ' · ' + esc(L.truck) : ''}<br>${Math.round(p.velocidad || 0)} km/h · ${hace(p.at)}${d ? `<br>Va a ${esc(d.nombre)}` : ''}`).addTo(map);
  }

  // Camiones con rastreador satelital (Sitrack): un marcador por patente
  const satMarkers = new Map();
  const satName = r => { const c = camion(r.camion_id); return c ? c.nombre : (r.nombre ? `${r.asset_id} (${r.nombre})` : r.asset_id); };
  const satOver = r => r.velocidad != null && r.velocidad > D.ajustes.velocidad_max && Date.now() - new Date(r.reporte_at || r.actualizado).getTime() < 5 * 60 * 1000;
  const satStale = r => Date.now() - new Date(r.reporte_at || r.actualizado).getTime() > 30 * 60 * 1000;
  function drawSat() {
    const seen = new Set();
    for (const r of D.rastreo) {
      if (r.lat == null || r.lon == null) continue;
      seen.add(r.asset_id);
      let m = satMarkers.get(r.asset_id);
      if (!m) {
        const el = document.createElement('div'); el.className = 'truck sat';
        el.innerHTML = `<div class="dot">${TRUCK_SVG}</div><div class="lbl"></div>`;
        el.addEventListener('click', ev => { ev.stopPropagation(); satPopup(r.asset_id); });
        m = new maplibregl.Marker({ element: el, anchor: 'top' }).setLngLat([r.lon, r.lat]).addTo(map);
        satMarkers.set(r.asset_id, m);
      }
      m.setLngLat([r.lon, r.lat]);
      const el = m.getElement();
      el.classList.toggle('over', satOver(r)); el.classList.toggle('stale', satStale(r));
      el.querySelector('.lbl').textContent = `🛰 ${satName(r)} · ${Math.round(r.velocidad || 0)} km/h`;
    }
    for (const [id, m] of satMarkers) if (!seen.has(id)) { m.remove(); satMarkers.delete(id); }
  }
  function satPopup(assetId) {
    const r = D.rastreo.find(x => x.asset_id === assetId); if (!r) return;
    new maplibregl.Popup({ offset: 10 }).setLngLat([r.lon, r.lat]).setHTML(`<b>🛰 ${esc(satName(r))}</b><br>${Math.round(r.velocidad || 0)} km/h · ${r.encendido == null ? '' : r.encendido ? 'motor encendido · ' : 'motor apagado · '}${hace(r.reporte_at || r.actualizado)}${r.direccion ? '<br>' + esc(r.direccion) : ''}`).addTo(map);
  }

  // Lugares
  const placeMarkers = [];
  function drawLugares() {
    placeMarkers.splice(0).forEach(m => m.remove());
    for (const l of guardados()) {
      const el = document.createElement('div'); el.className = 'place'; el.textContent = (TIPO[l.tipo] || TIPO.otro)[0]; el.title = l.nombre;
      el.addEventListener('click', ev => { ev.stopPropagation(); new maplibregl.Popup({ offset: 12 }).setLngLat([l.lon, l.lat]).setHTML(`<b>${esc(l.nombre)}</b><br>${esc((TIPO[l.tipo] || TIPO.otro)[1])}${l.direccion ? ' · ' + esc(l.direccion) : ''}${l.notas ? '<br>' + esc(l.notas) : ''}`).addTo(map); });
      placeMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([l.lon, l.lat]).addTo(map));
    }
  }
  let framed = false;
  function frameAll() {
    if (framed) return;
    const pts = [...D.posiciones.map(p => [p.lon, p.lat]), ...D.rastreo.filter(r => r.lat != null).map(r => [r.lon, r.lat]), ...D.lugares.map(l => [l.lon, l.lat])];
    if (!pts.length) return;
    framed = true;
    if (pts.length === 1) { map.jumpTo({ center: pts[0], zoom: 12 }); return; }
    const lo = pts.map(p => p[0]), la = pts.map(p => p[1]);
    map.fitBounds([[Math.min(...lo), Math.min(...la)], [Math.max(...lo), Math.max(...la)]], { padding: 60, maxZoom: 14, duration: 0 });
  }

  // Elegir un punto en el mapa (para lugares y para marcar calles)
  let picking = null;
  function startPick(fn, msg) { picking = fn; document.body.classList.add('picking'); toast(msg); }
  function stopPick() { picking = null; document.body.classList.remove('picking'); }
  map.on('click', e => { if (!picking) return; const fn = picking; stopPick(); fn(e.lngLat.lat, e.lngLat.lng); });

  // ---------- Render ----------
  function renderAll() {
    fillSelects(); renderLive(); renderAlerts(); renderViajes(); renderChoferes(); renderCamiones(); renderLugares(); renderCalles();
    $('f-ajustes').velocidad_max.value = D.ajustes.velocidad_max;
    renderSitrack(); renderAdmins(); renderEventos(); fillHistorial();
    drawTrucks(); drawSat(); drawLugares(); drawBloqueos(); drawRutas(); frameAll();
  }
  const opts = (arr, label, empty) => (empty != null ? `<option value="">${esc(empty)}</option>` : '') + arr.map(x => `<option value="${esc(x.id)}">${esc(label(x))}</option>`).join('');
  function fillSelects() {
    const keep = sel => { const v = sel.value; return () => { if ([...sel.options].some(o => o.value === v)) sel.value = v; }; };
    const fv = $('f-viaje'), fc = $('f-chofer');
    const lugLabel = l => `${(TIPO[l.tipo] || TIPO.otro)[0]} ${l.nombre}`;
    const camActivos = D.camiones.filter(c => c.activo);
    for (const [sel, html] of [
      [fv.chofer_id, opts(D.choferes, c => c.nombre, 'Elegí el chofer') + (me ? `<option value="${esc(me.id)}">Yo (${esc(me.nombre)})</option>` : '')],
      [fv.camion_id, opts(camActivos, c => c.nombre, 'El que tenga el chofer')],
      [fv.origen_id, opts(guardados(), lugLabel, 'Donde esté el camión') + NUEVO_OPT],
      [fv.destino_id, opts(guardados(), lugLabel, 'Elegí el destino') + NUEVO_OPT],
      [fc.camion_id, opts(camActivos, c => c.nombre, 'Ninguno')],
    ]) { const r = keep(sel); sel.innerHTML = html; r(); }
    if (!fv.fecha.value) fv.fecha.value = hoyISO();
  }

  function renderLive() {
    const box = $('live');
    const sat = [...D.rastreo].filter(r => r.lat != null).sort((a, b) => (satOver(b) - satOver(a)) || (satStale(a) - satStale(b)) || satName(a).localeCompare(satName(b)));
    const satHtml = sat.map(r => {
      const cls = satOver(r) ? ' over' : satStale(r) ? ' stale' : '';
      const sub = ['Satelital', r.encendido == null ? '' : r.encendido ? 'motor encendido' : 'motor apagado', r.direccion, hace(r.reporte_at || r.actualizado)].filter(Boolean).join(' · ');
      return `<div class="row${cls}"><span class="ico">🛰</span><span><span class="t">${esc(satName(r))} · ${Math.round(r.velocidad || 0)} km/h</span><br><span class="m">${esc(sub)}</span></span>
        <span class="acts"><button type="button" class="btn ghost sm" data-satfly="${esc(r.asset_id)}">Ver</button></span></div>`;
    }).join('');
    if (!D.posiciones.length) { box.innerHTML = satHtml || '<p class="empty">Todavía ningún chofer mandó su ubicación. Aparece cuando abren la app con la cuenta de la empresa.</p>'; return; }
    const rows = [...D.posiciones].sort((a, b) => (isOver(b) - isOver(a)) || (isStale(a) - isStale(b)) || posLabel(a).who.localeCompare(posLabel(b).who));
    box.innerHTML = rows.map(p => {
      const L = posLabel(p), v = p.viaje_id && byId(D.viajes, p.viaje_id), d = v && lugar(v.destino_id);
      const cls = isOver(p) ? ' over' : isStale(p) ? ' stale' : '';
      const sub = [L.truck, d ? 'va a ' + d.nombre : p.destino ? 'va a ' + p.destino : '', hace(p.at) + (isStale(p) ? ' (sin datos nuevos)' : '')].filter(Boolean).join(' · ');
      return `<div class="row${cls}"><span class="ico">🚚</span><span><span class="t">${esc(L.who)} · ${Math.round(p.velocidad || 0)} km/h</span><br><span class="m">${esc(sub)}</span></span>
        <span class="acts"><button type="button" class="btn ghost sm" data-fly="${esc(p.chofer_id)}">Ver</button></span></div>`;
    }).join('') + satHtml;
  }
  $('live').addEventListener('click', e => {
    const s = e.target.closest('[data-satfly]');
    if (s) { const r = D.rastreo.find(x => x.asset_id === s.dataset.satfly); if (r) { fly(r.lon, r.lat); satPopup(r.asset_id); } return; }
    const b = e.target.closest('[data-fly]'); if (!b) return; const p = D.posiciones.find(x => x.chofer_id === b.dataset.fly); if (p) { fly(p.lon, p.lat); truckPopup(p.chofer_id); } });

  function renderAlerts() {
    const box = $('alerts'), unseen = D.alertas.filter(a => !a.vista).length;
    $('badge-alertas').hidden = !unseen; $('badge-alertas').textContent = unseen;
    if (!D.alertas.length) { box.innerHTML = '<p class="empty">Sin alertas.</p>'; return; }
    box.innerHTML = (unseen ? '<button type="button" class="btn ghost sm" data-all-seen>Marcar todas como vistas</button>' : '') + D.alertas.slice(0, 40).map(a => {
      const c = chofer(a.chofer_id), t = camion(a.camion_id);
      const quienVa = c ? c.nombre : t ? t.nombre : a.asset_id || 'Chofer';
      const dur = a.fin ? Math.round((new Date(a.fin) - new Date(a.at)) / 60000) : 0;
      return `<div class="row stack${a.vista ? '' : ' unseen'}"><span class="ico">${a.origen === 'satelital' ? '🛰' : '⚠️'}</span><span><span class="t">${esc(quienVa)}: ${Math.round(a.velocidad)} km/h máx. (límite ${Math.round(a.limite)})</span><br><span class="m">${esc([c && t && t.nombre, dur >= 1 ? `durante ${dur} min` : '', a.direccion ? a.direccion.split(',').slice(0, 2).join(',') : '', a.origen === 'satelital' ? 'rastreador' : 'app', new Date(a.at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })].filter(Boolean).join(' · '))}</span></span>
        <span class="acts">${a.lat != null ? `<button type="button" class="btn ghost sm" data-where="${a.id}">Dónde</button>` : ''}${a.vista ? '' : `<button type="button" class="btn ghost sm" data-seen="${a.id}">Visto</button>`}</span></div>`;
    }).join('');
  }
  $('alerts').addEventListener('click', async e => {
    const w = e.target.closest('[data-where]'), s = e.target.closest('[data-seen]'), all = e.target.closest('[data-all-seen]');
    if (w) { const a = D.alertas.find(x => String(x.id) === w.dataset.where); if (a) { fly(a.lon, a.lat); new maplibregl.Popup().setLngLat([a.lon, a.lat]).setHTML(`<b>${Math.round(a.velocidad)} km/h</b><br>${esc(new Date(a.at).toLocaleString('es-AR'))}`).addTo(map); } }
    if (s) { await q(sb.from('alertas').update({ vista: true }).eq('id', s.dataset.seen), 'No se pudo marcar'); const a = D.alertas.find(x => String(x.id) === s.dataset.seen); if (a) a.vista = true; renderAlerts(); }
    if (all) { await q(sb.from('alertas').update({ vista: true }).eq('vista', false), 'No se pudo marcar'); D.alertas.forEach(a => { a.vista = true; }); renderAlerts(); }
  });

  // ---------- Viajes ----------
  function renderViajes() {
    const box = $('viajes');
    if (!D.viajes.length) { box.innerHTML = '<p class="empty">Todavía no hay viajes.</p>'; return; }
    const order = { en_curso: 0, pendiente: 1, terminado: 2, cancelado: 3 };
    const rows = [...D.viajes].sort((a, b) => order[a.estado] - order[b.estado] || (order[a.estado] < 2 ? a.fecha.localeCompare(b.fecha) : b.fecha.localeCompare(a.fecha)));
    box.innerHTML = rows.map(v => {
      const c = chofer(v.chofer_id), t = camion(v.camion_id), o = lugar(v.origen_id), d = lugar(v.destino_id);
      const rutaTxt = v.ruta_km ? `${fmt(Math.round(v.ruta_km))} km · ${durTxt(v.ruta_min)}${v.ruta_origen === 'chofer' ? ' (la que sigue el chofer)' : ' (planeada)'}` : '';
      const sub = [fechaTxt(v.fecha), c ? c.nombre : 'Sin chofer', t && t.nombre, o && 'desde ' + o.nombre, rutaTxt, v.notas].filter(Boolean).join(' · ');
      const acts = (v.ruta ? `<button type="button" class="btn ghost sm" data-ruta="${v.id}">Ver ruta</button>` : '') +
        (v.estado === 'en_curso' ? `<button type="button" class="btn ghost sm" data-fin="${v.id}">Terminar</button>` : '') +
        (v.estado === 'pendiente' || v.estado === 'en_curso' ? `<button type="button" class="btn danger sm" data-cancel="${v.id}">Cancelar</button>` : `<button type="button" class="btn danger sm" data-del="${v.id}">Borrar</button>`);
      return `<div class="row stack"><span class="ico">${d ? (TIPO[d.tipo] || TIPO.otro)[0] : '❓'}</span><span><span class="t">${esc(d ? d.nombre.replace(VIAJE_PREF, '') : 'Destino borrado')} <span class="state ${v.estado}">${ESTADO[v.estado]}</span></span><br><span class="m">${esc(sub)}</span></span><span class="acts">${acts}</span></div>`;
    }).join('');
  }
  // "Otra dirección…": buscar una dirección (o tocar el mapa) sin tener que cargarla antes en Lugares
  const NUEVO = '__nuevo', NUEVO_OPT = `<option value="${NUEVO}">➕ Otra dirección…</option>`;
  const otra = { origen_id: null, destino_id: null };   // { lat, lon, label, marker }
  function addrBox(campo) {
    const sel = $('f-viaje')[campo];
    const box = document.createElement('div'); box.className = 'wide where addr'; box.hidden = true;
    box.innerHTML = `<label>${campo === 'destino_id' ? 'Dirección de destino' : 'Dirección de salida'}<span class="inline"><input type="text" data-q placeholder="Calle y número, ciudad — o coordenadas"><button type="button" class="btn ghost sm" data-buscar>Buscar</button></span></label>
      <span class="inline"><button type="button" class="btn ghost sm" data-mapa>Tocar en el mapa</button><span class="tip" data-elegido>Todavía no elegiste el punto.</span></span>
      <div class="list" data-resultados></div>
      <span class="inline"><label class="check"><input type="checkbox" data-guardar checked> Guardarlo en Lugares como</label><select data-tipo><option value="cliente">Cliente</option><option value="deposito">Depósito</option><option value="otro">Otro</option></select></span>`;
    sel.closest('label').after(box);
    const setPunto = (lat, lon, label) => {
      if (otra[campo] && otra[campo].marker) otra[campo].marker.remove();
      const marker = new maplibregl.Marker({ color: campo === 'destino_id' ? '#c8102e' : '#12873e' }).setLngLat([lon, lat]).addTo(map);
      otra[campo] = { lat, lon, label, marker };
      box.querySelector('[data-elegido]').textContent = '✓ ' + label;
      box.querySelector('[data-resultados]').innerHTML = ''; fly(lon, lat, 14);
    };
    const buscar = async () => {
      const text = box.querySelector('[data-q]').value.trim();
      const m = text.match(/(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{1,3}\.\d{3,})/);
      if (m) { setPunto(+m[1], +m[2], `Ubicación ${(+m[1]).toFixed(5)}, ${(+m[2]).toFixed(5)}`); return; }
      if (text.length < 3) { toast('Escribí la dirección para buscar.', true); return; }
      const res = box.querySelector('[data-resultados]'); res.innerHTML = '<p class="empty">Buscando…</p>';
      const c = map.getCenter();
      const r = await N.funcion('rutas', { op: 'search', params: { text, 'boundary.country': 'AR', size: 6, 'focus.point.lat': c.lat, 'focus.point.lon': c.lng } }).catch(() => ({ ok: false, data: {} }));
      const fs = r.ok && r.data.features || [];
      if (!fs.length) { res.innerHTML = `<p class="empty">${esc(r.data?.error?.message || 'No encontré esa dirección.')} Probá con calle, número y ciudad, o tocá el mapa.</p>`; return; }
      res.innerHTML = fs.map((f, i) => `<button type="button" class="row" data-i="${i}" style="text-align:left;cursor:pointer"><span class="ico">📍</span><span class="t">${esc(f.properties.label.replace(/, Argentina$/, ''))}</span><span></span></button>`).join('');
      res.onclick = e => { const b = e.target.closest('[data-i]'); if (!b) return; const f = fs[+b.dataset.i]; setPunto(f.geometry.coordinates[1], f.geometry.coordinates[0], f.properties.label.replace(/, Argentina$/, '')); };
    };
    box.querySelector('[data-buscar]').addEventListener('click', buscar);
    box.querySelector('[data-q]').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); buscar(); } });
    box.querySelector('[data-mapa]').addEventListener('click', () => startPick((lat, lon) => setPunto(lat, lon, `Punto marcado en el mapa (${lat.toFixed(5)}, ${lon.toFixed(5)})`), 'Tocá el mapa en el lugar de ' + (campo === 'destino_id' ? 'destino' : 'salida')));
    sel.addEventListener('change', () => { box.hidden = sel.value !== NUEVO; if (!box.hidden) box.querySelector('[data-q]').focus(); });
    return box;
  }
  const addrBoxes = { origen_id: addrBox('origen_id'), destino_id: addrBox('destino_id') };
  function limpiarOtra() {
    for (const k of Object.keys(otra)) { if (otra[k] && otra[k].marker) otra[k].marker.remove(); otra[k] = null; addrBoxes[k].hidden = true; addrBoxes[k].querySelector('[data-q]').value = ''; addrBoxes[k].querySelector('[data-elegido]').textContent = 'Todavía no elegiste el punto.'; }
  }
  // Crea el lugar para una "otra dirección" (los viajes siempre apuntan a un lugar)
  async function lugarDeOtra(campo) {
    const o = otra[campo], box = addrBoxes[campo];
    const guardar = box.querySelector('[data-guardar]').checked;
    const nombre = o.label.split(',').slice(0, 2).join(',').slice(0, 80);
    const row = await q(sb.from('lugares').insert({ nombre: guardar ? nombre : VIAJE_PREF + nombre, tipo: guardar ? box.querySelector('[data-tipo]').value : 'otro', direccion: o.label.slice(0, 160), lat: +o.lat.toFixed(6), lon: +o.lon.toFixed(6) }).select().single(), 'No se pudo guardar la dirección');
    upsertLocal('lugares', row); return row.id;
  }
  $('f-viaje').chofer_id.addEventListener('change', e => { const c = chofer(e.target.value); if (c && c.camion_id) $('f-viaje').camion_id.value = c.camion_id; });
  $('f-viaje').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]');
    if (!f.chofer_id.value) { toast('Elegí el chofer. Si todavía no hay, crealo en la pestaña Choferes.', true); return; }
    for (const k of ['origen_id', 'destino_id']) if (f[k].value === NUEVO && !otra[k]) { toast(`Elegí la dirección de ${k === 'destino_id' ? 'destino' : 'salida'}: buscala o tocá el mapa.`, true); return; }
    if (f.origen_id.value && f.origen_id.value !== NUEVO && f.origen_id.value === f.destino_id.value) { toast('El origen y el destino son el mismo lugar.', true); return; }
    btn.disabled = true;
    try {
      const origenId = f.origen_id.value === NUEVO ? await lugarDeOtra('origen_id') : f.origen_id.value || null;
      const destinoId = f.destino_id.value === NUEVO ? await lugarDeOtra('destino_id') : f.destino_id.value;
      const row = await q(sb.from('viajes').insert({ chofer_id: f.chofer_id.value, camion_id: f.camion_id.value || null, origen_id: origenId, destino_id: destinoId, fecha: f.fecha.value, notas: f.notas.value.trim() || null }).select().single(), 'No se pudo asignar');
      upsertLocal('viajes', row); f.notas.value = ''; f.origen_id.value = ''; f.destino_id.value = ''; limpiarOtra(); fillSelects(); renderLugares(); drawLugares(); renderViajes(); renderLive();
      toast(`Viaje asignado a ${chofer(row.chofer_id)?.nombre || 'el chofer'}. Le aparece en la app. Calculando la ruta…`);
      planRoute(row);
    } catch (err) { /* ya avisado */ } finally { btn.disabled = false; }
  });
  const durTxt = m => { m = Math.round(m || 0); const h = Math.floor(m / 60); return h ? `${h} h ${m % 60} min` : `${m} min`; };
  // Ruta planeada para camión: desde el lugar de salida, o desde donde está el camión (Sitrack o la app), hasta el destino
  async function planRoute(v) {
    const d = lugar(v.destino_id); if (!d) return;
    const camId = v.camion_id || chofer(v.chofer_id)?.camion_id || null, T = camion(camId);
    const o = lugar(v.origen_id);
    const sat = camId && D.rastreo.find(r => r.camion_id === camId && r.lat != null);
    const app = D.posiciones.find(p => p.chofer_id === v.chofer_id);
    const from = o ? [o.lon, o.lat] : sat ? [sat.lon, sat.lat] : app ? [app.lon, app.lat] : null;
    if (!from) { toast('Viaje asignado. La ruta se va a ver cuando el chofer toque IR (no hay lugar de salida ni ubicación del camión).'); return; }
    const body = { coordinates: [from, [d.lon, d.lat]], language: 'es', instructions: false, units: 'm', radiuses: [2000, 2000],
      options: { vehicle_type: 'hgv', profile_params: { restrictions: T ? { height: +T.alto, weight: +T.peso, length: +T.largo, width: +T.ancho, axleload: +T.eje, hazmat: !!T.peligrosa } : {} } } };
    const av = D.bloqueos.map(b => { const dy = 0.00035, dx = 0.00035 / Math.cos(b.lat * Math.PI / 180); return [[[b.lon - dx, b.lat - dy], [b.lon + dx, b.lat - dy], [b.lon + dx, b.lat + dy], [b.lon - dx, b.lat + dy], [b.lon - dx, b.lat - dy]]]; });
    if (av.length) body.options.avoid_polygons = { type: 'MultiPolygon', coordinates: av };
    let r = await N.funcion('rutas', { op: 'directions', body, elegir: true }).catch(() => null);
    if (r && !r.ok && av.length) { delete body.options.avoid_polygons; r = await N.funcion('rutas', { op: 'directions', body, elegir: true }).catch(() => null); } // viajes largos: sin esquivar
    const f = r && r.ok && r.data.features && r.data.features[0];
    if (!f) { toast('No se pudo calcular la ruta planeada: ' + (r?.data?.error?.message || 'el servicio de rutas no respondió') + '. Se va a ver cuando el chofer toque IR.', true); return; }
    const c = f.geometry.coordinates, step = Math.max(1, Math.ceil(c.length / 400)), pts = [];
    for (let i = 0; i < c.length; i += step) pts.push([+c[i][0].toFixed(5), +c[i][1].toFixed(5)]);
    pts.push([+c[c.length - 1][0].toFixed(5), +c[c.length - 1][1].toFixed(5)]);
    const km = +(f.properties.summary.distance / 1000).toFixed(1), min = Math.round(f.properties.summary.duration / 60);
    const { data: row, error } = await sb.from('viajes').update({ ruta: { type: 'LineString', coordinates: pts }, ruta_km: km, ruta_min: min, ruta_origen: 'panel', ruta_at: new Date().toISOString() }).eq('id', v.id).select().single();
    if (error) { fail(error, 'No se pudo guardar la ruta'); return; }
    upsertLocal('viajes', row); renderViajes(); showPlan(row);
    toast(`Ruta planeada: ${fmt(Math.round(km))} km, ${durTxt(min)}${T ? ' (con las medidas de ' + T.nombre + ')' : ''}.`);
  }
  $('viajes').addEventListener('click', async e => {
    const r = e.target.closest('[data-ruta]');
    if (r) { const v = byId(D.viajes, r.dataset.ruta); if (v) showPlan(v); return; }
    const fin = e.target.closest('[data-fin]');
    if (fin && confirm('¿Dar este viaje por terminado?')) {
      await q(sb.rpc('cambiar_estado_viaje', { p_viaje: fin.dataset.fin, p_estado: 'terminado' }), 'No se pudo terminar');
      const v = byId(D.viajes, fin.dataset.fin); if (v) { v.estado = 'terminado'; v.terminado = new Date().toISOString(); }
      renderViajes(); renderLive(); toast('Viaje terminado.'); return;
    }
    const c = e.target.closest('[data-cancel]'), d = e.target.closest('[data-del]');
    if (c && confirm('¿Cancelar este viaje? Al chofer le deja de aparecer.')) { const row = await q(sb.from('viajes').update({ estado: 'cancelado' }).eq('id', c.dataset.cancel).select().single(), 'No se pudo cancelar'); upsertLocal('viajes', row); renderViajes(); }
    if (d && confirm('¿Borrar este viaje del historial?')) { await q(sb.from('viajes').delete().eq('id', d.dataset.del), 'No se pudo borrar'); D.viajes = D.viajes.filter(v => v.id !== d.dataset.del); renderViajes(); }
  });

  // ---------- Choferes ----------
  const randPin = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, '0');
  $('f-chofer').pin.value = randPin();
  $('b-pin').addEventListener('click', () => { $('f-chofer').pin.value = randPin(); });
  $('f-chofer').nombre.addEventListener('input', e => { const f = $('f-chofer'); if (!f.usuario.dataset.touched) f.usuario.value = N.limpiarUsuario(e.target.value.split(' ')[0]).replace(/[^a-z0-9._-]/g, ''); });
  $('f-chofer').usuario.addEventListener('input', e => { e.target.dataset.touched = '1'; });
  const appUrl = () => new URL('./', location.href).href;
  function credsCard(nombre, usuario, pin) {
    const txt = `Hola ${nombre}! Entrá a la app de Camiones AR: ${appUrl()}\nUsuario: ${usuario}\nPIN: ${pin}\nEntrás una sola vez y el celular queda conectado.`;
    const box = $('new-chofer');
    box.innerHTML = `<b>Listo. Pasale esto a ${esc(nombre)}:</b><p>App: ${esc(appUrl())}<br>Usuario: <b>${esc(usuario)}</b><br>PIN: <b>${esc(pin)}</b></p>
      <span class="inline"><button type="button" class="btn ghost sm" id="b-copy">Copiar</button><a class="btn go sm" target="_blank" rel="noopener" href="https://wa.me/?text=${encodeURIComponent(txt)}">Mandar por WhatsApp</a></span>
      <p class="tip">El PIN no se vuelve a mostrar. Si se lo olvida, poné uno nuevo desde la lista.</p>`;
    box.hidden = false;
    $('b-copy').addEventListener('click', () => navigator.clipboard.writeText(txt).then(() => toast('Copiado'), () => toast('No se pudo copiar', true)));
  }
  $('f-chofer').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]'); btn.disabled = true;
    const body = { accion: 'crear', nombre: f.nombre.value.trim(), usuario: f.usuario.value.trim(), pin: f.pin.value.trim(), camion_id: f.camion_id.value || null, telefono: f.telefono.value.trim() || null };
    try {
      const r = await N.funcion('choferes', body);
      if (!r.ok) { toast(r.data.error?.message || 'No se pudo crear el chofer', true); return; }
      credsCard(body.nombre, r.data.usuario, body.pin);
      f.reset(); delete f.usuario.dataset.touched; f.pin.value = randPin();
      await loadAll();
    } catch (err) { fail(err, 'No se pudo crear el chofer'); } finally { btn.disabled = false; }
  });
  function renderChoferes() {
    const box = $('choferes');
    if (!D.choferes.length) { box.innerHTML = '<p class="empty">Todavía no hay choferes.</p>'; return; }
    box.innerHTML = D.choferes.map(c => {
      const p = D.posiciones.find(x => x.chofer_id === c.id);
      return `<div class="row stack"><span class="ico">👤</span><span><span class="t">${esc(c.nombre)}</span><br><span class="m">Usuario: ${esc(c.usuario)}${c.telefono ? ' · ' + esc(c.telefono) : ''} · ${p ? 'última ubicación ' + hace(p.at) : 'todavía no entró'}</span>
        <label class="m" style="display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap">Camión <select data-cam="${c.id}" style="min-width:0;flex:1">${opts(D.camiones.filter(x => x.activo), x => x.nombre, 'Ninguno')}</select></label></span>
        <span class="acts"><button type="button" class="btn ghost sm" data-pin="${c.id}">Nuevo PIN</button><button type="button" class="btn ghost sm" data-out="${c.id}" title="Lo desconecta de todos sus celulares">Desconectar</button><button type="button" class="btn danger sm" data-delch="${c.id}">Borrar</button></span></div>`;
    }).join('');
    box.querySelectorAll('[data-cam]').forEach(s => { s.value = chofer(s.dataset.cam).camion_id || ''; });
  }
  $('choferes').addEventListener('change', async e => {
    const s = e.target.closest('[data-cam]'); if (!s) return;
    const row = await q(sb.from('perfiles').update({ camion_id: s.value || null }).eq('id', s.dataset.cam).select().single(), 'No se pudo cambiar el camión');
    upsertLocal('choferes', row); toast('Camión actualizado');
  });
  $('choferes').addEventListener('click', async e => {
    const pin = e.target.closest('[data-pin]'), out = e.target.closest('[data-out]'), del = e.target.closest('[data-delch]');
    const b = pin || out || del; if (!b) return;
    const c = chofer(b.dataset.pin || b.dataset.out || b.dataset.delch);
    if (!c) return;
    if (pin) {
      const nuevo = prompt(`Nuevo PIN para ${c.nombre} (4 a 8 números). Se va a tener que volver a conectar:`, randPin());
      if (!nuevo) return;
      const r = await N.funcion('choferes', { accion: 'pin', id: c.id, pin: nuevo.trim() });
      if (!r.ok) { toast(r.data.error?.message || 'No se pudo cambiar el PIN', true); return; }
      credsCard(c.nombre, c.usuario, nuevo.trim()); $('new-chofer').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (out && confirm(`¿Desconectar a ${c.nombre} de todos sus celulares? Va a tener que entrar de nuevo con su PIN (en menos de una hora deja de mandar datos).`)) {
      const r = await N.funcion('choferes', { accion: 'cerrar', id: c.id });
      toast(r.ok ? `${c.nombre} desconectado` : (r.data.error?.message || 'No se pudo'), !r.ok);
    }
    if (del && confirm(`¿Borrar a ${c.nombre}? No va a poder entrar más. Sus viajes quedan en el historial sin chofer.`)) {
      const r = await N.funcion('choferes', { accion: 'borrar', id: c.id });
      if (!r.ok) { toast(r.data.error?.message || 'No se pudo borrar', true); return; }
      await loadAll(); toast(`${c.nombre} borrado`);
    }
  });

  // ---------- Camiones ----------
  const F = [['nombre', 'Nombre', 'text'], ['patente', 'Patente (como en Sitrack)', 'opt'], ['alto', 'Alto (m)', 0.05], ['peso', 'Peso total (t)', 0.5], ['largo', 'Largo (m)', 0.5], ['ancho', 'Ancho (m)', 0.05], ['eje', 'Peso por eje (t)', 0.5]];
  function renderCamiones() {
    const box = $('camiones');
    const list = D.camiones.filter(c => c.activo);
    if (!list.length) { box.innerHTML = '<p class="empty">Todavía no hay camiones.</p>'; return; }
    box.innerHTML = list.map(c => `<form class="tcard" data-camion="${c.id}">
      ${F.map(([k, l, st]) => st === 'text' ? `<label>${l}<input name="${k}" type="text" required maxlength="60" value="${esc(c[k])}"></label>` : st === 'opt' ? `<label>${l}<input name="${k}" type="text" maxlength="20" autocapitalize="characters" placeholder="AB123CD" value="${esc(c[k] || '')}"></label>` : `<label>${l}<input name="${k}" type="number" inputmode="decimal" step="${st}" required value="${esc(c[k])}"></label>`).join('')}
      <label class="check wide"><input name="peligrosa" type="checkbox" ${c.peligrosa ? 'checked' : ''}> Lleva carga peligrosa</label>
      <span class="inline wide"><button type="submit" class="btn go sm">Guardar</button><button type="button" class="btn danger sm" data-delcam>Borrar</button></span></form>`).join('');
  }
  const camionDe = f => ({ nombre: f.nombre.value.trim(), patente: f.patente.value.trim().toUpperCase() || null, ...Object.fromEntries(F.slice(2).map(([k]) => [k, parseFloat(String(f[k].value).replace(',', '.'))])), peligrosa: f.peligrosa.checked });
  $('camiones').addEventListener('submit', async e => {
    e.preventDefault(); const f = e.target;
    const row = await q(sb.from('camiones').update(camionDe(f)).eq('id', f.dataset.camion).select().single(), 'No se pudo guardar (revisá las medidas)');
    upsertLocal('camiones', row); fillSelects(); toast('Camión guardado');
  });
  $('camiones').addEventListener('click', async e => {
    if (!e.target.closest('[data-delcam]')) return;
    const f = e.target.closest('form'), c = camion(f.dataset.camion);
    if (!confirm(`¿Borrar ${c.nombre}? Deja de aparecer en la app de los choferes.`)) return;
    // Se desactiva (no se borra) para no perder el historial de viajes y alertas
    const row = await q(sb.from('camiones').update({ activo: false }).eq('id', c.id).select().single(), 'No se pudo borrar');
    upsertLocal('camiones', row); renderCamiones(); fillSelects();
  });
  $('b-add-camion').addEventListener('click', async () => {
    const row = await q(sb.from('camiones').insert({ nombre: 'Camión nuevo' }).select().single(), 'No se pudo agregar');
    upsertLocal('camiones', row); renderCamiones(); fillSelects();
    const f = document.querySelector(`[data-camion="${row.id}"]`); if (f) { f.scrollIntoView({ behavior: 'smooth', block: 'center' }); f.nombre.select(); }
  });

  // ---------- Lugares ----------
  const fl = $('f-lugar');
  function setWhere(lat, lon, txt) {
    fl.lat.value = lat; fl.lon.value = lon;
    $('lugar-where').textContent = `Ubicación: ${txt ? txt + ' — ' : ''}${(+lat).toFixed(5)}, ${(+lon).toFixed(5)}`;
    pickMarker && pickMarker.remove();
    pickMarker = new maplibregl.Marker({ color: '#12873e' }).setLngLat([lon, lat]).addTo(map);
    fly(lon, lat, 16);
  }
  let pickMarker = null;
  function resetLugar() {
    fl.reset(); fl.id.value = ''; fl.lat.value = ''; fl.lon.value = ''; $('lugar-res').innerHTML = '';
    $('lugar-title').textContent = 'Nuevo lugar'; $('b-lugar-cancel').hidden = true;
    $('lugar-where').textContent = 'Ubicación: buscá la dirección, pegá las coordenadas o tocá el mapa.';
    pickMarker && pickMarker.remove(); pickMarker = null;
  }
  $('b-lugar-mapa').addEventListener('click', () => startPick((lat, lon) => setWhere(lat, lon, 'marcado en el mapa'), 'Tocá el mapa donde está el lugar (la entrada de camiones)'));
  $('b-lugar-buscar').addEventListener('click', async () => {
    const text = (fl.direccion.value || fl.nombre.value).trim();
    const m = text.match(/(-?\d{1,2}\.\d{3,})\s*[, ]\s*(-?\d{1,3}\.\d{3,})/);
    if (m) { setWhere(+m[1], +m[2], 'coordenadas pegadas'); return; }
    if (text.length < 3) { toast('Escribí la dirección (o el nombre) para buscar.', true); return; }
    const box = $('lugar-res'); box.innerHTML = '<p class="empty">Buscando…</p>';
    const c = map.getCenter();
    const r = await N.funcion('rutas', { op: 'search', params: { text, 'boundary.country': 'AR', size: 6, 'focus.point.lat': c.lat, 'focus.point.lon': c.lng } }).catch(() => ({ ok: false, data: {} }));
    if (!r.ok || !r.data.features) { box.innerHTML = `<p class="empty">${esc(r.data.error?.message || 'El buscador no respondió.')} Podés tocar el mapa.</p>`; return; }
    if (!r.data.features.length) { box.innerHTML = '<p class="empty">No encontré esa dirección. Probá tocando el mapa.</p>'; return; }
    box.innerHTML = r.data.features.map((f, i) => `<button type="button" class="row" data-res="${i}" style="text-align:left;cursor:pointer"><span class="ico">📍</span><span class="t">${esc(f.properties.label.replace(/, Argentina$/, ''))}</span><span></span></button>`).join('');
    box.onclick = e => { const b = e.target.closest('[data-res]'); if (!b) return; const f = r.data.features[+b.dataset.res]; setWhere(f.geometry.coordinates[1], f.geometry.coordinates[0], f.properties.label.replace(/, Argentina$/, '')); if (!fl.direccion.value) fl.direccion.value = f.properties.name || ''; box.innerHTML = ''; };
  });
  $('b-lugar-cancel').addEventListener('click', resetLugar);
  fl.addEventListener('submit', async e => {
    e.preventDefault();
    if (!fl.lat.value) { toast('Falta la ubicación: buscá la dirección o tocá el mapa.', true); return; }
    const data = { nombre: fl.nombre.value.trim(), tipo: fl.tipo.value, direccion: fl.direccion.value.trim() || null, notas: fl.notas.value.trim() || null, lat: +fl.lat.value, lon: +fl.lon.value };
    const row = await q(fl.id.value ? sb.from('lugares').update(data).eq('id', fl.id.value).select().single() : sb.from('lugares').insert(data).select().single(), 'No se pudo guardar el lugar');
    upsertLocal('lugares', row); D.lugares.sort((a, b) => a.nombre.localeCompare(b.nombre));
    resetLugar(); renderLugares(); drawLugares(); fillSelects(); toast('Lugar guardado');
  });
  function renderLugares() {
    const box = $('lugares');
    if (!guardados().length) { box.innerHTML = '<p class="empty">Todavía no hay lugares. Empezá por la base (por ejemplo, Delta Point).</p>'; return; }
    box.innerHTML = guardados().map(l => `<div class="row stack"><span class="ico">${(TIPO[l.tipo] || TIPO.otro)[0]}</span><span><span class="t">${esc(l.nombre)}</span><br><span class="m">${esc([(TIPO[l.tipo] || TIPO.otro)[1], l.direccion, l.notas].filter(Boolean).join(' · '))}</span></span>
      <span class="acts"><button type="button" class="btn ghost sm" data-lfly="${l.id}">Ver</button><button type="button" class="btn ghost sm" data-ledit="${l.id}">Editar</button><button type="button" class="btn danger sm" data-ldel="${l.id}">Borrar</button></span></div>`).join('');
  }
  $('lugares').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const l = lugar(b.dataset.lfly || b.dataset.ledit || b.dataset.ldel); if (!l) return;
    if (b.dataset.lfly) fly(l.lon, l.lat, 16);
    if (b.dataset.ledit) {
      fl.id.value = l.id; fl.nombre.value = l.nombre; fl.tipo.value = l.tipo; fl.direccion.value = l.direccion || ''; fl.notas.value = l.notas || '';
      setWhere(l.lat, l.lon, 'actual'); $('lugar-title').textContent = 'Editar lugar'; $('b-lugar-cancel').hidden = false;
      fl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (b.dataset.ldel) {
      if (D.viajes.some(v => v.destino_id === l.id)) { toast('Ese lugar es destino de algún viaje: borrá o cambiá esos viajes primero.', true); return; }
      if (!confirm(`¿Borrar ${l.nombre}?`)) return;
      await q(sb.from('lugares').delete().eq('id', l.id), 'No se pudo borrar');
      D.lugares = D.lugares.filter(x => x.id !== l.id); renderLugares(); drawLugares(); fillSelects();
    }
  });

  // ---------- Calles marcadas ----------
  const quien = id => { if (!id) return 'alguien'; if (me && id === me.id) return 'vos'; const c = chofer(id); return c ? c.nombre : 'alguien'; };
  function renderCalles() {
    const box = $('calles');
    if (!D.bloqueos.length) { box.innerHTML = '<p class="empty">No hay calles marcadas.</p>'; return; }
    box.innerHTML = D.bloqueos.map(b => `<div class="row"><span class="ico">⛔</span><span><span class="t">${esc(b.calle || 'Calle sin nombre')}</span><br><span class="m">Marcó ${esc(quien(b.creado_por))} · ${esc(hace(b.creado))}${b.nota ? ' · ' + esc(b.nota) : ''}</span></span>
      <span class="acts"><button type="button" class="btn ghost sm" data-bfly="${b.id}">Ver</button><button type="button" class="btn danger sm" data-bdel="${b.id}">Sacar</button></span></div>`).join('');
  }
  $('calles').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const x = byId(D.bloqueos, b.dataset.bfly || b.dataset.bdel); if (!x) return;
    if (b.dataset.bfly) fly(x.lon, x.lat, 17);
    if (b.dataset.bdel && confirm(`¿Sacar "${x.calle || 'esta calle'}"? Las rutas van a volver a usarla.`)) {
      await q(sb.from('bloqueos').delete().eq('id', x.id), 'No se pudo sacar');
      D.bloqueos = D.bloqueos.filter(y => y.id !== x.id); renderCalles(); drawBloqueos();
    }
  });
  $('b-marcar').addEventListener('click', () => startPick(async (lat, lon) => {
    const calle = prompt('¿Qué calle es? (para que los choferes la reconozcan)', '');
    if (calle === null) return;
    const row = await q(sb.from('bloqueos').insert({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), calle: calle.trim() || null, creado_por: me.id }).select().single(), 'No se pudo marcar');
    upsertLocal('bloqueos', row, true); renderCalles(); drawBloqueos(); toast('Calle marcada: las rutas de todos la esquivan.');
  }, 'Tocá en el mapa la calle por donde no se puede pasar'));

  // ---------- Fotomultas ----------
  D.radares = []; D.admins = [];
  async function loadRadares() {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb.from('radares').select('*').eq('activo', true).order('id').range(from, from + 999);
      if (error) return;                       // todavía no está la tabla
      out.push(...data); if (data.length < 1000) break;
    }
    D.radares = out; renderCams(); drawCams();
  }
  function renderCams() {
    const osm = D.radares.filter(r => r.fuente === 'osm').length, man = D.radares.filter(r => r.fuente === 'manual');
    $('cam-resumen').textContent = D.radares.length ? `${D.radares.length} fotomultas cargadas: ${osm} de OpenStreetMap y ${man.length} a mano.` : 'Todavía no hay fotomultas cargadas. Empezá trayéndolas de OpenStreetMap.';
    $('cams').innerHTML = man.length ? man.map(r => `<div class="row"><span class="ico">📷</span><span><span class="t">${r.maxima ? 'Máxima ' + r.maxima + ' km/h' : 'Sin máxima'}</span><br><span class="m">${esc([r.nota, 'marcó ' + quien(r.creado_por), hace(r.creado)].filter(Boolean).join(' · '))}</span></span>
      <span class="acts"><button type="button" class="btn ghost sm" data-cfly="${r.id}">Ver</button><button type="button" class="btn danger sm" data-cdel="${r.id}">Borrar</button></span></div>`).join('') : '<p class="empty">Ninguna todavía.</p>';
  }
  function drawCams() {
    const s = map.getSource && map.getSource('radares'); if (!s) return;
    s.setData({ type: 'FeatureCollection', features: D.radares.map(r => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [r.lon, r.lat] }, properties: { id: r.id } })) });
  }
  function camPopup(r) {
    const div = document.createElement('div');
    div.innerHTML = `<b>📷 Fotomulta${r.maxima ? ' · máx. ' + r.maxima + ' km/h' : ''}</b><br><span>${r.fuente === 'osm' ? 'De OpenStreetMap' : 'Marcada por ' + esc(quien(r.creado_por))}</span>
      <div class="inline" style="margin-top:8px"><button type="button" class="btn ghost sm" data-e>Cambiar máxima</button><button type="button" class="btn danger sm" data-d>Borrar</button></div>`;
    const pop = new maplibregl.Popup().setLngLat([r.lon, r.lat]).setDOMContent(div).addTo(map);
    div.querySelector('[data-e]').addEventListener('click', async () => {
      const v = prompt('Velocidad máxima de esta fotomulta (km/h):', r.maxima || ''); if (v === null) return;
      const n = parseInt(v, 10); if (!(n >= 10 && n <= 150)) { toast('Poné un número entre 10 y 150.', true); return; }
      const row = await q(sb.from('radares').update({ maxima: n }).eq('id', r.id).select().single(), 'No se pudo cambiar');
      upsertLocal('radares', row); pop.remove(); renderCams();
    });
    div.querySelector('[data-d]').addEventListener('click', async () => {
      if (!confirm('¿Borrar esta fotomulta?')) return;
      await q(sb.from('radares').delete().eq('id', r.id), 'No se pudo borrar');
      D.radares = D.radares.filter(x => x.id !== r.id); pop.remove(); renderCams(); drawCams();
    });
  }
  $('cams').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const r = byId(D.radares, b.dataset.cfly || b.dataset.cdel); if (!r) return;
    if (b.dataset.cfly) { fly(r.lon, r.lat, 16); camPopup(r); }
    if (b.dataset.cdel && confirm('¿Borrar esta fotomulta?')) {
      await q(sb.from('radares').delete().eq('id', r.id), 'No se pudo borrar');
      D.radares = D.radares.filter(x => x.id !== r.id); renderCams(); drawCams();
    }
  });
  $('b-cam').addEventListener('click', () => startPick(async (lat, lon) => {
    const v = prompt('Velocidad máxima de la fotomulta (km/h). Dejalo vacío si no la sabés:', '80'); if (v === null) return;
    const n = v.trim() ? parseInt(v, 10) : null;
    if (n !== null && !(n >= 10 && n <= 150)) { toast('Poné un número entre 10 y 150.', true); return; }
    const row = await q(sb.from('radares').insert({ lat: +lat.toFixed(6), lon: +lon.toFixed(6), maxima: n, creado_por: me.id }).select().single(), 'No se pudo marcar');
    D.radares.push(row); renderCams(); drawCams(); toast('Fotomulta cargada: les avisa a todos los choferes.');
  }, 'Tocá en el mapa el lugar exacto de la fotomulta'));
  $('b-osm').addEventListener('click', async () => {
    const b = $('b-osm'); b.disabled = true; b.textContent = 'Trayendo… (puede tardar 1 o 2 minutos)';
    try {
      const r = await N.funcion('radares', {});
      if (r.ok && r.data.ok) { toast(`Listo: ${r.data.total} fotomultas de OpenStreetMap (${r.data.conMaxima} con velocidad máxima).`); await loadRadares(); }
      else toast('OpenStreetMap: ' + (r.data.error || 'no respondió. Probá de nuevo en un rato.'), true);
    } catch (e) { fail(e, 'OpenStreetMap'); } finally { b.disabled = false; b.textContent = 'Traer de OpenStreetMap'; }
  });

  // ---------- Administradores ----------
  function renderAdmins() {
    const box = $('admins'); if (!box) return;
    const soyDueno = me && me.rol === 'dueno';
    box.innerHTML = D.admins.map(a => `<div class="row stack"><span class="ico">${a.rol === 'dueno' ? '👑' : a.solo_lectura ? '👀' : '🧑‍💼'}</span><span><span class="t">${esc(a.nombre)}${me && a.id === me.id ? ' (vos)' : ''}</span><br><span class="m">${a.rol === 'dueno' ? 'Dueño' : a.solo_lectura ? 'Solo mira' : 'Administrador'}${a.email ? ' · ' + esc(a.email) : a.usuario ? ' · usuario ' + esc(a.usuario) : ''}</span></span>
      <span class="acts">${soyDueno && a.rol === 'admin' ? `<button type="button" class="btn ghost sm" data-aperm="${a.id}">${a.solo_lectura ? 'Darle permisos completos' : 'Pasar a solo mirar'}</button><button type="button" class="btn ghost sm" data-aclave="${a.id}">Nueva contraseña</button><button type="button" class="btn danger sm" data-adel="${a.id}">Borrar</button>` : ''}</span></div>`).join('');
  }
  $('admins').addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const a = byId(D.admins, b.dataset.aclave || b.dataset.adel || b.dataset.aperm); if (!a) return;
    if (b.dataset.aperm) {
      const solo = !a.solo_lectura;
      if (!confirm(solo ? `¿${a.nombre} pasa a solo mirar? No va a poder cambiar nada.` : `¿Darle a ${a.nombre} permisos completos (asignar viajes, crear choferes, editar)?`)) return;
      const r = await N.funcion('choferes', { accion: 'permiso_admin', id: a.id, solo_lectura: solo });
      if (!r.ok) { toast(r.data.error?.message || 'No se pudo', true); return; }
      a.solo_lectura = solo; renderAdmins(); toast('Listo. Se aplica la próxima vez que entre o recargue.');
    }
    if (b.dataset.aclave) {
      const clave = prompt(`Nueva contraseña para ${a.nombre} (mínimo 6 caracteres; mejor 8 o más):`, ''); if (!clave) return;
      const r = await N.funcion('choferes', { accion: 'clave_admin', id: a.id, clave });
      toast(r.ok ? 'Contraseña cambiada. Tiene que volver a entrar.' : (r.data.error?.message || 'No se pudo'), !r.ok);
    }
    if (b.dataset.adel && confirm(`¿Borrar a ${a.nombre}? No va a poder entrar más al panel.`)) {
      const r = await N.funcion('choferes', { accion: 'borrar_admin', id: a.id });
      if (!r.ok) { toast(r.data.error?.message || 'No se pudo borrar', true); return; }
      D.admins = D.admins.filter(x => x.id !== a.id); renderAdmins(); toast(`${a.nombre} borrado`);
    }
  });
  $('f-admin').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]'); btn.disabled = true;
    try {
      const r = await N.funcion('choferes', { accion: 'crear_admin', nombre: f.nombre.value.trim(), email: f.email.value.trim(), clave: f.clave.value, solo_lectura: f.solo.checked });
      if (!r.ok) { toast(r.data.error?.message || 'No se pudo crear', true); return; }
      toast(`Listo: ${f.nombre.value.trim()} entra al panel (${location.href.replace(/[?#].*$/, '')}) con "${f.email.value.trim().includes('@') ? f.email.value.trim() : N.limpiarUsuario(f.email.value)}" y la contraseña que pusiste.`);
      f.reset();
      const ad = await sb.from('perfiles').select('*').in('rol', ['dueno', 'admin']).order('nombre');
      if (!ad.error) { D.admins = ad.data; renderAdmins(); }
    } finally { btn.disabled = false; }
  });

  // ---------- Llegadas y salidas ----------
  D.eventos = [];
  const inicioDia = iso => new Date(iso + 'T00:00:00-03:00').toISOString();
  function eventoTxt(e) {
    const l = lugar(e.lugar_id), t = camion(e.camion_id), c = chofer(e.chofer_id);
    const quien = t ? t.nombre : c ? c.nombre : e.asset_id || 'Un camión';
    return `${quien} ${e.tipo === 'llegada' ? 'llegó a' : 'salió de'} ${l ? l.nombre.replace(VIAJE_PREF, '') : 'un lugar'}`;
  }
  function renderEventos() {
    const box = $('eventos'); if (!box) return;
    const hoy = D.eventos.filter(e => e.at >= inicioDia(hoyISO()));
    box.innerHTML = hoy.length ? hoy.slice(0, 30).map(e => `<div class="row"><span class="ico">${e.tipo === 'llegada' ? '🏁' : '🚚'}</span><span><span class="t">${esc(eventoTxt(e))}</span><br><span class="m">${new Date(e.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}</span></span><span></span></div>`).join('')
      : '<p class="empty">Todavía nada hoy. Se avisa cuando un camión entra o sale de un lugar guardado (a menos de 250 m).</p>';
  }

  // ---------- Historial: recorrido del día y resumen ----------
  function fillHistorial() {
    const f = $('f-reco'), v = f.quien.value;
    f.quien.innerHTML = '<option value="">Elegí…</option>' +
      `<optgroup label="Camiones">${D.camiones.filter(c => c.activo).map(c => `<option value="c:${esc(c.id)}">${esc(c.nombre)}</option>`).join('')}</optgroup>` +
      `<optgroup label="Choferes (app)">${D.choferes.map(c => `<option value="p:${esc(c.id)}">${esc(c.nombre)}</option>`).join('')}</optgroup>`;
    if (v) f.quien.value = v;
    if (!f.dia.value) f.dia.value = hoyISO();
    const r = $('f-resumen');
    if (!r.hasta.value) { r.hasta.value = hoyISO(); const d = new Date(Date.now() - 6 * 864e5); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); r.desde.value = d.toISOString().slice(0, 10); }
  }
  const metros = (a, b) => { const R = 6371000, k = Math.PI / 180, x = (b[0] - a[0]) * k * Math.cos((a[1] + b[1]) / 2 * k), y = (b[1] - a[1]) * k; return Math.sqrt(x * x + y * y) * R; };
  let recoMarkers = [];
  $('f-reco').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, [tipo, id] = f.quien.value.split(':'), box = $('reco-res');
    if (!id) return;
    box.innerHTML = '<p class="empty">Buscando…</p>';
    const desde = inicioDia(f.dia.value), hasta = new Date(new Date(desde).getTime() + 864e5).toISOString();
    const pts = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await sb.from('recorridos').select('lat, lon, velocidad, at, fuente').eq(tipo === 'c' ? 'camion_id' : 'chofer_id', id)
        .gte('at', desde).lt('at', hasta).order('at').range(from, from + 999);
      if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
      pts.push(...data); if (data.length < 1000) break;
    }
    // Si hay datos del rastreador, se usan esos (son más parejos); si no, los de la app
    const sat = pts.filter(p => p.fuente === 'satelital'), usar = tipo === 'c' && sat.length > 1 ? sat : pts;
    recoMarkers.forEach(m => m.remove()); recoMarkers = [];
    const src = map.getSource('historial');
    if (usar.length < 2) { if (src) src.setData(EMPTY); box.innerHTML = '<p class="empty">No hay recorrido guardado ese día. Se guarda desde que se activó el historial.</p>'; return; }
    const coords = usar.map(p => [p.lon, p.lat]);
    let km = 0, vmax = 0;
    for (let i = 1; i < usar.length; i++) {
      const m = metros(coords[i - 1], coords[i]), s = (new Date(usar[i].at) - new Date(usar[i - 1].at)) / 1000;
      if (s > 0 && m / s < 42) km += m;                       // descarta saltos imposibles
      vmax = Math.max(vmax, usar[i].velocidad || 0);
    }
    if (src) src.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} });
    const hora = p => new Date(p.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
    for (const [p, txt, color] of [[usar[0], 'Salida ' + hora(usar[0]), '#12873e'], [usar[usar.length - 1], 'Último ' + hora(usar[usar.length - 1]), '#c8102e']]) {
      recoMarkers.push(new maplibregl.Marker({ color }).setLngLat([p.lon, p.lat]).setPopup(new maplibregl.Popup().setText(txt)).addTo(map));
    }
    const lo = coords.map(c => c[0]), la = coords.map(c => c[1]);
    map.fitBounds([[Math.min(...lo), Math.min(...la)], [Math.max(...lo), Math.max(...la)]], { padding: 60, duration: 700 });
    const { data: evs } = await sb.from('eventos').select('*').eq(tipo === 'c' ? 'camion_id' : 'chofer_id', id).gte('at', desde).lt('at', hasta).order('at');
    box.innerHTML = `<p class="okmsg">${fmt(km >= 10000 ? Math.round(km / 1000) : (km / 1000).toFixed(1))} km · de ${hora(usar[0])} a ${hora(usar[usar.length - 1])} · máxima ${Math.round(vmax)} km/h · ${usar === sat ? 'rastreador' : 'app'}</p>` +
      ((evs || []).length ? '<div class="list">' + evs.map(e => `<div class="row"><span class="ico">${e.tipo === 'llegada' ? '🏁' : '🚚'}</span><span class="t">${hora(e)} · ${esc(eventoTxt(e))}</span><span></span></div>`).join('') + '</div>' : '');
  });
  $('f-resumen').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, box = $('resumen');
    box.innerHTML = '<p class="empty">Calculando…</p>';
    const { data, error } = await sb.rpc('resumen', { p_desde: f.desde.value, p_hasta: f.hasta.value });
    if (error) { box.innerHTML = `<p class="err">${esc(error.message)}</p>`; return; }
    const tabla = (titulo, filas) => `<h2>${titulo}</h2><div class="card"><table class="tabla"><thead><tr><th></th><th>Km</th><th>Viajes</th><th>Excesos</th><th>Máx.</th></tr></thead><tbody>${
      filas.map(r => `<tr><td>${esc(r.nombre)}</td><td>${fmt(r.km)}</td><td>${r.viajes}</td><td class="${r.excesos ? 'mal' : ''}">${r.excesos}</td><td>${r.vmax ? Math.round(r.vmax) : '–'}</td></tr>`).join('') || '<tr><td colspan="5">Sin datos</td></tr>'}</tbody></table></div>`;
    box.innerHTML = tabla('Por camión', data.camiones) + tabla('Por chofer (app)', data.choferes) +
      '<p class="tip">Los km salen del rastreador satelital o de la app del chofer, desde que se activó el historial. Excesos = tramos por encima de la velocidad máxima.</p>';
  });

  // ---------- Rastreador satelital (Sitrack) ----------
  function renderSitrack() {
    const box = $('sitrack'); if (!box) return;
    const st = D.sitrack;
    if (!st || !st.at) { box.innerHTML = '<p class="tip">Todavía no se conectó. Cuando estén cargados el usuario y la contraseña de API de Sitrack, se actualiza solo cada minuto.</p>'; return; }
    const sin = (st.sin_asociar || []);
    box.innerHTML = `<p class="${st.ok ? 'okmsg' : 'err'}">${st.ok ? '✓ ' : '✕ '}${esc(st.mensaje || '')}<br><span class="m">Última consulta ${esc(hace(st.at))}</span></p>
      ${sin.length ? `<p class="tip">Unidades de Sitrack sin camión asociado: <b>${sin.map(esc).join(', ')}</b>. Cargá esa patente en el camión que corresponda (pestaña Camiones).</p>` : ''}`;
  }
  $('b-sitrack').addEventListener('click', async () => {
    const b = $('b-sitrack'); b.disabled = true; b.textContent = 'Consultando…';
    try {
      const r = await N.funcion('sitrack', {});
      toast(r.ok && r.data.ok ? `Sitrack: ${r.data.unidades} unidades actualizadas` : `Sitrack: ${r.data.error || 'no respondió'}`, !(r.ok && r.data.ok));
      const { data } = await sb.from('sitrack_estado').select('*').eq('id', 1).maybeSingle(); if (data) { D.sitrack = data; renderSitrack(); }
    } catch (e) { fail(e, 'Sitrack'); } finally { b.disabled = false; b.textContent = 'Probar ahora'; }
  });

  // ---------- Ajustes ----------
  $('f-ajustes').addEventListener('submit', async e => {
    e.preventDefault();
    const v = parseInt(e.target.velocidad_max.value, 10);
    const row = await q(sb.from('ajustes').update({ velocidad_max: v }).eq('id', 1).select().single(), 'No se pudo guardar');
    D.ajustes = row; renderLive(); drawTrucks(); toast(`Velocidad máxima: ${v} km/h. Les llega a todos los choferes.`);
  });

  // ---------- En vivo ----------
  function upsertLocal(k, row, front) {
    const i = D[k].findIndex(x => (x.id ?? x.chofer_id) === (row.id ?? row.chofer_id));
    if (i >= 0) D[k][i] = row; else if (front) D[k].unshift(row); else D[k].push(row);
  }
  let audio = null;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      for (const [t, f] of [[0, 880], [0.25, 1100]]) {
        const o = audio.createOscillator(), g = audio.createGain(); o.frequency.value = f; o.type = 'square';
        g.gain.setValueAtTime(0.15, audio.currentTime + t); g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + t + 0.2);
        o.connect(g).connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.2);
      }
    } catch (e) { /* sin sonido */ }
  }
  document.addEventListener('click', () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); audio.resume(); } catch (e) { /* nada */ } }, { once: true });

  let channel = null, reloadT = 0;
  function subscribe() {
    if (channel) return;
    const later = () => { clearTimeout(reloadT); reloadT = setTimeout(loadAll, 800); };
    channel = sb.channel('panel')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'posiciones' }, p => {
        if (p.eventType === 'DELETE') D.posiciones = D.posiciones.filter(x => x.chofer_id !== p.old.chofer_id); else upsertLocal('posiciones', p.new);
        drawTrucks(); drawRutas(); if (tab === 'vivo') renderLive();
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'alertas' }, p => {
        const a = D.alertas.find(x => x.id === p.new.id); if (a) { Object.assign(a, p.new); renderAlerts(); }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'eventos' }, p => {
        D.eventos.unshift(p.new); renderEventos();
        toast(`${p.new.tipo === 'llegada' ? '🏁' : '🚚'} ${eventoTxt(p.new)}`);
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'alertas' }, p => {
        D.alertas.unshift(p.new); renderAlerts(); beep();
        const c = chofer(p.new.chofer_id), t = camion(p.new.camion_id);
        const quienVa = c ? c.nombre : t ? t.nombre : p.new.asset_id || 'Un chofer';
        toast(`${p.new.origen === 'satelital' ? '🛰' : '⚠️'} ${quienVa} va a ${Math.round(p.new.velocidad)} km/h (máx. ${Math.round(p.new.limite)})`, true);
        if ('Notification' in window && Notification.permission === 'granted' && document.hidden) new Notification('Exceso de velocidad', { body: `${quienVa}: ${Math.round(p.new.velocidad)} km/h`, icon: 'icons/icon-192.png' });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bloqueos' }, p => {
        if (p.eventType === 'INSERT' && p.new.creado_por !== me.id) toast(`⛔ ${quien(p.new.creado_por)} marcó "${p.new.calle || 'una calle'}" como No puedo pasar`);
        later();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'viajes' }, later)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'radares' }, p => { if (p.new.fuente === 'manual' && !byId(D.radares, p.new.id)) { D.radares.push(p.new); renderCams(); drawCams(); } })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'rastreo' }, p => {
        if (p.eventType === 'DELETE') D.rastreo = D.rastreo.filter(x => x.asset_id !== p.old.asset_id);
        else { const i = D.rastreo.findIndex(x => x.asset_id === p.new.asset_id); if (i >= 0) D.rastreo[i] = p.new; else D.rastreo.push(p.new); }
        drawSat(); if (tab === 'vivo') renderLive();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'sitrack_estado' }, p => { if (p.new) { D.sitrack = p.new; renderSitrack(); } })
      .subscribe();
  }
  // "hace X min" y camiones sin datos se actualizan solos
  setInterval(() => { if (me) { drawTrucks(); drawSat(); renderSitrack(); if (tab === 'vivo') renderLive(); } }, 30000);

  // ---------- Entrar / salir ----------
  let me = null;
  async function start() {
    const s = await N.sesion();
    if (!s) { $('login').hidden = false; $('layout').hidden = true; return; }
    let p = null;
    try { p = await N.cargarPerfil(true); } catch (e) { /* abajo */ }
    if (!p || (p.rol !== 'dueno' && p.rol !== 'admin')) {
      await N.salir();
      $('login-err').textContent = 'Este panel es solo para el dueño y los administradores. Los choferes usan la app.'; $('login-err').hidden = false;
      $('login').hidden = false; $('layout').hidden = true; return;
    }
    me = p;
    $('who').textContent = p.nombre + (p.rol === 'admin' ? ' · administrador' : ''); $('b-logout').hidden = false;
    $('f-admin').hidden = p.rol !== 'dueno';
    document.body.classList.toggle('lector', !!p.solo_lectura);   // solo mira: se esconden los botones para cambiar cosas
    $('login').hidden = true; $('layout').hidden = false; map.resize();
    await loadAll(); subscribe(); loadRadares();
    if ('Notification' in window && Notification.permission === 'default') document.addEventListener('click', () => Notification.requestPermission().catch(() => {}), { once: true });
  }
  $('f-login').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target, btn = f.querySelector('[type=submit]'); btn.disabled = true; $('login-err').hidden = true;
    try { await N.entrar(f.email.value, f.password.value); f.password.value = ''; await start(); }
    catch (err) { $('login-err').textContent = err.message; $('login-err').hidden = false; }
    finally { btn.disabled = false; }
  });
  $('b-logout').addEventListener('click', async () => {
    if (channel) { sb.removeChannel(channel); channel = null; }
    me = null; await N.salir(); location.reload();
  });
  start();
})();
