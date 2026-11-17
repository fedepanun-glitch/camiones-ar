// Camiones AR — función "rutas".
// Pasa los pedidos de rutas y búsquedas a openrouteservice (HeiGIT) con la clave guardada en el servidor.
// La clave NUNCA llega al celular: se guarda como secreto ORS_KEY en Supabase.
// Solo atiende a usuarios que entraron a la app (dueño o choferes).
import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

// HeiGIT reemplazó api.openrouteservice.org por api.heigit.org/<servicio>/<versión>/…
const BASE = (Deno.env.get('ORS_BASE') || 'https://api.heigit.org').replace(/\/+$/, '');
const KEY = Deno.env.get('ORS_KEY') || '';
const PATHS = {
  directions: '/openrouteservice/v2/directions/driving-hgv/geojson',
  search: '/pelias/v1/search',
  reverse: '/pelias/v1/reverse',
} as const;
// Parámetros de búsqueda permitidos (lo demás se descarta)
const PARAMS = ['text', 'size', 'boundary.country', 'focus.point.lat', 'focus.point.lon', 'point.lat', 'point.lon', 'layers', 'lang'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// ---------- Elegir el camino mejor para camión ----------
// Se piden hasta 3 caminos y se elige el que menos va por calles chicas y, dentro de las ciudades con
// Red de Tránsito Pesado (CABA, Quilmes y otras ciudades cargadas), el que más va por esa red. Aunque tarde unos minutos más.
const CEL = 0.002;                       // grilla de ~200 m para buscar rápido los tramos de la red
type Red = { grid: Map<string, number[][]>; zonas: number[][]; caja: number[]; caba: number[][] };
let red: Red | null = null, redAt = 0;
const metros = (lon1: number, lat1: number, lon2: number, lat2: number) => {
  const k = Math.PI / 180, x = (lon2 - lon1) * k * Math.cos((lat1 + lat2) / 2 * k), y = (lat2 - lat1) * k;
  return Math.sqrt(x * x + y * y) * 6371000;
};
async function cargarRed(): Promise<Red> {
  if (red && Date.now() - redAt < 3600_000) return red;
  const grid = new Map<string, number[][]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from('red_pesada').select('coords').order('osm_id').range(from, from + 999);
    if (error || !data) break;
    for (const r of data) {
      const c = r.coords as number[][];
      for (let i = 1; i < c.length; i++) {
        const sg = [c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]];
        for (let x = Math.floor(Math.min(sg[0], sg[2]) / CEL); x <= Math.floor(Math.max(sg[0], sg[2]) / CEL); x++)
          for (let y = Math.floor(Math.min(sg[1], sg[3]) / CEL); y <= Math.floor(Math.max(sg[1], sg[3]) / CEL); y++) {
            const k = x + ':' + y; (grid.get(k) || grid.set(k, []).get(k)!).push(sg);
          }
      }
    }
    if (data.length < 1000) break;
  }
  // Bordes de las zonas (los tramos del límite, en cualquier orden: alcanza para saber si un punto está adentro)
  const zonas: number[][] = [], caba: number[][] = []; const caja = [180, 90, -180, -90];
  const { data: zs } = await supabase.from('zonas').select('id, anillos');
  for (const z of zs || []) for (const lin of z.anillos as number[][][]) for (let i = 1; i < lin.length; i++) {
    const sg = [lin[i - 1][0], lin[i - 1][1], lin[i][0], lin[i][1]];
    zonas.push(sg); if (z.id === 'caba') caba.push(sg);
    caja[0] = Math.min(caja[0], lin[i][0]); caja[1] = Math.min(caja[1], lin[i][1]); caja[2] = Math.max(caja[2], lin[i][0]); caja[3] = Math.max(caja[3], lin[i][1]);
  }
  red = { grid, zonas, caja, caba }; redAt = Date.now();
  return red;
}
function enZona(lon: number, lat: number, r: Red, bordes = r.zonas) {
  if (!bordes.length || lon < r.caja[0] || lon > r.caja[2] || lat < r.caja[1] || lat > r.caja[3]) return false;
  let dentro = false;
  for (const [x1, y1, x2, y2] of bordes) if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) dentro = !dentro;
  return dentro;
}
function cercaDeRed(lon: number, lat: number, r: Red) {
  const gx = Math.floor(lon / CEL), gy = Math.floor(lat / CEL);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const [x1, y1, x2, y2] of r.grid.get((gx + dx) + ':' + (gy + dy)) || []) {
    const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
    const ax = (x1 - lon) * kx, ay = (y1 - lat) * ky, bx = (x2 - lon) * kx, by = (y2 - lat) * ky, vx = bx - ax, vy = by - ay;
    const L = vx * vx + vy * vy, t = L ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L)) : 0;
    if (Math.hypot(ax + t * vx, ay + t * vy) < 30) return true;
  }
  return false;
}
// deno-lint-ignore no-explicit-any
function puntuar(f: any, r: Red, bitren = false) {
  const dur = f.properties?.summary?.duration || 0;
  const wt: { value: number; amount: number }[] = f.properties?.extras?.waytype?.summary || [];
  const calles = wt.filter(x => x.value >= 3 && x.value <= 5).reduce((a, x) => a + x.amount, 0) / 100;   // calle, camino de tierra
  const c: number[][] = f.geometry?.coordinates || [];
  // Tramos por ruta/autopista principal (tipo 1): cuentan como red aunque OpenStreetMap no los marque
  const principal = new Uint8Array(c.length);
  for (const [a, b, v] of (f.properties?.extras?.waytype?.values || []) as number[][]) if (v === 1) for (let i = a; i <= b && i < c.length; i++) principal[i] = 1;
  let dentro = 0, fuera = 0, enCaba = 0;
  for (let i = 1; i < c.length; i++) {
    const lon = (c[i - 1][0] + c[i][0]) / 2, lat = (c[i - 1][1] + c[i][1]) / 2;
    if (!enZona(lon, lat, r)) continue;
    const m = metros(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
    dentro += m; if (bitren && enZona(lon, lat, r, r.caba)) enCaba += m; if (!(principal[i - 1] && principal[i]) && !cercaDeRed(lon, lat, r)) fuera += m;
  }
  const fueraRed = dentro > 0 ? fuera / dentro : 0;
  // Bitrenes (22,40 m o más): en CABA solo pueden usar corredores específicos (Ley 6675, art. 9.10.6 del Código de Tránsito):
  // se prefiere fuertemente el camino que menos entra a la ciudad.
  const total = f.properties?.summary?.distance || 1;
  const enCiudad = bitren ? enCaba / total : 0;
  return { costo: dur * (1 + 0.8 * calles + 2 * fueraRed + 6 * enCiudad), calles: +calles.toFixed(3), enRed: dentro > 0 ? +(1 - fueraRed).toFixed(3) : null, kmEnZona: +(dentro / 1000).toFixed(1), kmEnCaba: +(enCaba / 1000).toFixed(1) };
}

// ---------- Zonas prohibidas por ordenanza (p. ej. Rosario: semirremolques y acoplados) ----------
type Zona = { id: string; nombre: string; anillo: number[][]; largo_min: number | null; peso_min: number | null; nota: string | null; fuente: string | null; horario: { dias?: number[]; franjas?: string[][] } | null; solo_aviso?: boolean };
let zonasP: Zona[] = [], zonasAt = 0;
async function cargarZonas(): Promise<Zona[]> {
  if (zonasAt && Date.now() - zonasAt < 600_000) return zonasP;
  const { data } = await supabase.from('zonas_prohibidas').select('id, nombre, anillo, largo_min, peso_min, nota, fuente, horario, solo_aviso').eq('activo', true);
  zonasP = (data || []) as Zona[]; zonasAt = Date.now();
  return zonasP;
}
function adentro(lon: number, lat: number, anillo: number[][]) {
  let d = false;
  for (let i = 1; i < anillo.length; i++) {
    const [x1, y1] = anillo[i - 1], [x2, y2] = anillo[i];
    if ((y1 > lat) !== (y2 > lat) && lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1) d = !d;
  }
  return d;
}
// ¿Rige ahora? (hora de Argentina, UTC-3). Sin horario: rige siempre.
function rigeAhora(z: Zona, ahora = new Date()) {
  const h = z.horario; if (!h) return true;
  const ar = new Date(ahora.getTime() - 3 * 3600_000);
  const dia = ar.getUTCDay() || 7, min = ar.getUTCHours() * 60 + ar.getUTCMinutes();
  if (h.dias && h.dias.length && !h.dias.includes(dia)) return false;
  if (!h.franjas || !h.franjas.length) return true;
  const m = (t: string) => { const [a, b] = t.split(':').map(Number); return a * 60 + (b || 0); };
  return h.franjas.some(([d, a]) => min >= m(d) && min < m(a));
}
// Devuelve las zonas que aplican a este camión: las que se esquivan y las que no se pueden esquivar (el viaje empieza o termina adentro)
function zonasPara(zs: Zona[], camion: { largo?: number; peso?: number } | undefined, coords: number[][]) {
  const largo = Number(camion?.largo) || 0, peso = Number(camion?.peso) || 0;
  const ext = [coords[0], coords[coords.length - 1]].filter(Boolean);
  if (!ext.length) return { evitar: [], dentro: [], avisos: [] };
  // Reglas locales que solo se avisan (estacionamiento, carga y descarga) donde empieza o termina el viaje
  const avisos = zs.filter(z => z.solo_aviso && ext.some(c => adentro(c[0], c[1], z.anillo)));
  zs = zs.filter(z => !z.solo_aviso);
  // Solo las zonas cerca del viaje (dentro del rectángulo salida-llegada, más ~30 km)
  const M = 0.3, x0 = Math.min(...ext.map(c => c[0])) - M, x1 = Math.max(...ext.map(c => c[0])) + M, y0 = Math.min(...ext.map(c => c[1])) - M, y1 = Math.max(...ext.map(c => c[1])) + M;
  const cerca = (z: Zona) => z.anillo.some(([x, y]) => x >= x0 && x <= x1 && y >= y0 && y <= y1);
  const aplica = zs.filter(z => ((z.largo_min != null && largo >= z.largo_min) || (z.peso_min != null && peso >= z.peso_min)) && cerca(z) && rigeAhora(z));
  const dentro = aplica.filter(z => ext.some(c => adentro(c[0], c[1], z.anillo)));
  return { evitar: aplica.filter(z => !dentro.includes(z)), dentro, avisos };
}

// ---------- Restricciones de la ANSV (feriados, eventos): tramos y horarios en que no pueden circular camiones ----------
type Ansv = { id: number; desde: string; hasta: string; titulo: string; detalle: string | null; franjas: string[][] | null;
  tramos: { ruta: string; nombre: string; puntos: number[][] }[] | null; excepciones: string | null; fuente: string | null; fuente_url: string | null };
let ansvL: Ansv[] = [], ansvAt = 0;
async function cargarAnsv(): Promise<Ansv[]> {
  if (ansvAt && Date.now() - ansvAt < 600_000) return ansvL;
  const { data } = await supabase.from('restricciones_ansv').select('*').gt('hasta', new Date().toISOString());
  ansvL = (data || []) as Ansv[]; ansvAt = Date.now();
  return ansvL;
}
function distSeg(lon: number, lat: number, x1: number, y1: number, x2: number, y2: number) {
  const kx = Math.cos(lat * Math.PI / 180) * 111320, ky = 110540;
  const ax = (x1 - lon) * kx, ay = (y1 - lat) * ky, bx = (x2 - lon) * kx, by = (y2 - lat) * ky, vx = bx - ax, vy = by - ay;
  const L = vx * vx + vy * vy, t = L ? Math.max(0, Math.min(1, -(ax * vx + ay * vy) / L)) : 0;
  return Math.hypot(ax + t * vx, ay + t * vy);
}
// ¿El viaje (de salida a llegada) pasa por algún momento en que rige la restricción? Se mira cada 10 minutos.
function viajeEnFranja(r: Ansv, salida: Date, llegada: Date) {
  const d = new Date(r.desde).getTime(), h = new Date(r.hasta).getTime();
  for (let t = salida.getTime(); t <= llegada.getTime() + 1; t += 600_000) {
    if (t < d || t > h) continue;
    if (!r.franjas || !r.franjas.length) return true;
    const ar = new Date(t - 3 * 3600_000), min = ar.getUTCHours() * 60 + ar.getUTCMinutes();
    const m = (x: string) => { const [a, b] = x.split(':').map(Number); return a * 60 + (b || 0); };
    if (r.franjas.some(([a, b]) => min >= m(a) && min < m(b))) return true;
  }
  return false;
}
function ansvEnRuta(rs: Ansv[], c: number[][], durS: number, salida = new Date()) {
  const llegada = new Date(salida.getTime() + durS * 1000), out = [];
  for (const r of rs) {
    if (!viajeEnFranja(r, salida, llegada)) continue;
    for (const t of r.tramos || []) {
      const P = t.puntos; if (!P || P.length < 2) continue;
      const bx = [Math.min(...P.map(p => p[0])) - 0.05, Math.max(...P.map(p => p[0])) + 0.05, Math.min(...P.map(p => p[1])) - 0.05, Math.max(...P.map(p => p[1])) + 0.05];
      let m = 0;
      for (let i = 1; i < c.length; i++) {
        const lon = (c[i - 1][0] + c[i][0]) / 2, lat = (c[i - 1][1] + c[i][1]) / 2;
        if (lon < bx[0] || lon > bx[1] || lat < bx[2] || lat > bx[3]) continue;
        let d = Infinity; for (let j = 1; j < P.length; j++) d = Math.min(d, distSeg(lon, lat, P[j - 1][0], P[j - 1][1], P[j][0], P[j][1]));
        if (d < 3000) m += metros(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
      }
      if (m >= 8000) out.push({ titulo: r.titulo, tramo: `${t.ruta} (${t.nombre})`, km: Math.round(m / 1000), detalle: r.detalle, excepciones: r.excepciones, hasta: r.hasta, franjas: r.franjas, fuente: r.fuente, fuente_url: r.fuente_url });
    }
  }
  return out;
}

// ---------- Buscador: links de Google Maps, coordenadas y direcciones exactas ----------
// Además del buscador general (Pelias), se entienden:
//  - links de Google Maps (también el texto que manda WhatsApp con el link): si traen coordenadas se usan tal cual;
//    si solo traen la dirección (p. ej. "Virrey Vértiz & Gorriti, Boulogne"), se busca esa dirección;
//  - coordenadas pegadas ("-34.51, -58.56");
//  - calle con altura o esquina ("Gorriti 1234", "Vértiz y Gorriti"): primero en Georef, el servicio oficial de
//    direcciones de Argentina (apis.datos.gob.ar), que ubica la altura exacta.
type Lugar = { lat: number; lon: number; label: string; name: string; housenumber?: string; fuente: string };
const feature = (l: Lugar) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
  properties: { label: l.label, name: l.name, housenumber: l.housenumber ?? null, fuente: l.fuente } });
const enArgentina = (la: number, lo: number) => la < -21 && la > -56 && lo < -53 && lo > -74.5;
const sinTildes = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const norm = (s: string) => sinTildes(s).toLowerCase().replace(/\s+/g, ' ').trim();
const decodificar = (s: string) => { try { return decodeURIComponent(s.replace(/\+/g, ' ')); } catch { return s.replace(/\+/g, ' '); } };
const titulo = (s: string) => s.toLowerCase().replace(/(^|[\s(.-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase())
  .replace(/\b(De|Del|La|Las|Los|Y|E)\b/g, m => m.toLowerCase()).replace(/\bAv\b/g, 'Av.');

function coordsDe(s: string): [number, number] | null {
  const pats = [
    /!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/,                                                   // marcador del lugar (lo más exacto)
    /[?&](?:q|query|ll|daddr|destination|center|saddr)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/i,  // ?q=-34.5,-58.5
    /\/place\/(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/,
    /@(-?\d+\.\d+),(-?\d+\.\d+)/,                                                        // centro del mapa
    /^\s*(-?\d{1,2}\.\d{3,})\s*[,; ]\s*(-?\d{1,3}\.\d{3,})\s*$/,                          // "-34.51, -58.56"
  ];
  for (const p of pats) {
    const m = s.match(p);
    if (m) { const la = +m[1], lo = +m[2]; if (enArgentina(la, lo)) return [la, lo]; }
  }
  return null;
}

/** Sigue el link (maps.app.goo.gl → google.com/maps…) y saca coordenadas o, si no hay, la dirección escrita. */
async function abrirLink(url: string): Promise<{ coords: [number, number] | null; texto: string | null }> {
  let u = url, texto: string | null = null;
  // El texto se saca antes de decodificar: la dirección puede traer un "&" ("Vértiz & Gorriti")
  const textoDe = (x: string) => {
    try {
      const uu = new URL(x);
      for (const k of ['q', 'query', 'daddr', 'destination']) { const v = uu.searchParams.get(k); if (v && v.trim()) return v.trim(); }
      const p = uu.pathname.match(/\/place\/([^/@]+)/)?.[1];
      if (p) return decodificar(p).trim();
    } catch { /* no es un link válido */ }
    return null;
  };
  for (let i = 0; i < 6; i++) {
    const c = coordsDe(decodificar(u)); if (c) return { coords: c, texto: null };
    texto = textoDe(u) || texto;
    let host = '';
    try { host = new URL(u).hostname; } catch { break; }
    if (!/(^|\.)(goo\.gl|g\.co|google\.[a-z.]+)$/.test(host)) break;
    const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) CamionesAR' }, signal: AbortSignal.timeout(8000) });
    const loc = r.headers.get('location');
    await r.body?.cancel();
    if (!loc) break;
    u = new URL(loc, u).href;
  }
  return { coords: null, texto: texto && !/^https?:/i.test(texto) ? texto : null };
}

const PROVINCIAS: Record<string, string> = Object.fromEntries([
  'Buenos Aires', 'Catamarca', 'Chaco', 'Chubut', 'Córdoba', 'Corrientes', 'Entre Ríos', 'Formosa', 'Jujuy', 'La Pampa', 'La Rioja',
  'Mendoza', 'Misiones', 'Neuquén', 'Río Negro', 'Salta', 'San Juan', 'San Luis', 'Santa Cruz', 'Santa Fe', 'Santiago del Estero',
  'Tierra del Fuego', 'Tucumán',
].map(p => [norm(p), p]).concat([['caba', 'Ciudad Autónoma de Buenos Aires'], ['capital federal', 'Ciudad Autónoma de Buenos Aires'],
  ['ciudad autonoma de buenos aires', 'Ciudad Autónoma de Buenos Aires'], ['ciudad de buenos aires', 'Ciudad Autónoma de Buenos Aires']]));

const dist2 = (a: [number, number], b: [number, number]) => metros(a[1], a[0], b[1], b[0]);

/** Direcciones exactas con Georef (calle + altura, o esquina). */
async function georef(texto: string, foco: [number, number] | null): Promise<Lugar[]> {
  const t = texto.replace(/\b[A-Z]\d{4}[A-Z]{0,3}\b/g, ' ').replace(/,?\s*argentina\s*$/i, '');   // saca códigos postales y "Argentina"
  const partes = t.split(',').map(s => s.trim()).filter(Boolean);
  if (!partes.length) return [];
  const dir = sinTildes(partes[0]).replace(/\s*&\s*/g, ' y ').replace(/\s+esq(uina|\.)?\s+/i, ' y ').replace(/\bn[°º]\s*/i, '').trim();
  if (!/\d/.test(dir) && !/\sy\s/i.test(dir)) return [];   // sin altura ni esquina: mejor el buscador general
  const resto = partes.slice(1).map(p => p.replace(/^(provincia de|prov\.?|pcia\.?)\s+/i, '').trim()).filter(Boolean);
  const provTxt = resto.find(p => PROVINCIAS[norm(p)]);
  const otros = resto.filter(p => p !== provTxt);
  const q = new URL('https://apis.datos.gob.ar/georef/api/direcciones');
  q.searchParams.set('direccion', dir); q.searchParams.set('max', '10');
  if (provTxt) q.searchParams.set('provincia', PROVINCIAS[norm(provTxt)]);
  const ql = otros[0] ? new URL('https://apis.datos.gob.ar/georef/api/localidades') : null;
  if (ql) { ql.searchParams.set('nombre', otros[0]); ql.searchParams.set('max', '1'); if (provTxt) ql.searchParams.set('provincia', PROVINCIAS[norm(provTxt)]); }
  const pedir = (u: URL) => fetch(u, { signal: AbortSignal.timeout(7000) }).then(r => r.ok ? r.json() : null).catch(() => null);
  const [rd, rl] = await Promise.all([pedir(q), ql ? pedir(ql) : Promise.resolve(null)]);
  // deno-lint-ignore no-explicit-any
  const ds: any[] = rd?.direcciones || [];
  const cl = rl?.localidades?.[0]?.centroide;
  const ref: [number, number] | null = cl && cl.lat != null ? [cl.lat, cl.lon] : foco;
  const out = ds.filter(d => d.ubicacion && d.ubicacion.lat != null).map(d => {
    const nom = String(d.nomenclatura || '');
    const coincide = otros.filter(o => norm(nom).includes(norm(o))).length;
    const lugar: Lugar = { lat: d.ubicacion.lat, lon: d.ubicacion.lon, fuente: 'georef',
      label: titulo(nom.split(',')[0]) + nom.slice(nom.indexOf(',') >= 0 ? nom.indexOf(',') : nom.length),
      name: titulo(nom.split(',')[0]), housenumber: d.altura?.valor != null ? String(d.altura.valor) : undefined };
    return { lugar, orden: -coincide * 1e9 + (ref ? dist2(ref, [lugar.lat, lugar.lon]) : 0) };
  });
  out.sort((a, b) => a.orden - b.orden);
  return out.slice(0, 5).map(x => x.lugar);
}

/** Buscador general (Pelias de HeiGIT). */
// deno-lint-ignore no-explicit-any
async function pelias(texto: string, params: Record<string, unknown> | undefined): Promise<any[]> {
  const u = new URL(BASE + PATHS.search);
  for (const k of PARAMS) { const v = params?.[k]; if (v != null && v !== '' && k !== 'text') u.searchParams.set(k, String(v).slice(0, 200)); }
  u.searchParams.set('text', texto.slice(0, 200));
  u.searchParams.set('api_key', KEY);
  const r = await fetch(u, { headers: { Accept: 'application/json', Authorization: KEY }, signal: AbortSignal.timeout(10000) });
  if (r.status === 401 || r.status === 403) throw new Error('clave');
  if (!r.ok) return [];
  return (await r.json()).features || [];
}
/** Nombre de la dirección en unas coordenadas (para mostrar algo legible). */
async function nombreEn(la: number, lo: number): Promise<string | null> {
  try {
    const u = new URL(BASE + PATHS.reverse);
    u.searchParams.set('point.lat', String(la)); u.searchParams.set('point.lon', String(lo)); u.searchParams.set('size', '1'); u.searchParams.set('api_key', KEY);
    const r = await fetch(u, { headers: { Accept: 'application/json', Authorization: KEY }, signal: AbortSignal.timeout(6000) });
    if (!r.ok) return null;
    const l = (await r.json()).features?.[0]?.properties?.label;
    return l ? String(l).replace(/, Argentina$/, '') : null;
  } catch { return null; }
}

async function buscar(params: Record<string, unknown> | undefined) {
  const texto = String(params?.text ?? '').slice(0, 1000).trim();
  const fla = Number(params?.['focus.point.lat']), flo = Number(params?.['focus.point.lon']);
  const foco: [number, number] | null = Number.isFinite(fla) && Number.isFinite(flo) ? [fla, flo] : null;
  const primeros: Lugar[] = [];
  let busca = texto, delLink = false;
  const link = texto.match(/https?:\/\/[^\s<>"]+/i)?.[0];
  if (link) {
    delLink = true;
    try {
      const r = await abrirLink(link);
      if (r.coords) {
        const [la, lo] = r.coords;
        const n = await nombreEn(la, lo);
        primeros.push({ lat: la, lon: lo, fuente: 'link', name: 'Ubicación del link de Google Maps', label: 'Ubicación exacta del link' + (n ? ` (cerca de ${n})` : '') });
      }
      busca = r.texto || texto.replace(link, '').trim();
    } catch { busca = texto.replace(link, '').trim(); }
  }
  if (!primeros.length) {
    const c = coordsDe(busca);
    if (c) {
      const n = await nombreEn(c[0], c[1]);
      primeros.push({ lat: c[0], lon: c[1], fuente: 'coordenadas', name: `${c[0].toFixed(5)}, ${c[1].toFixed(5)}`,
        label: `Coordenadas ${c[0].toFixed(5)}, ${c[1].toFixed(5)}` + (n ? ` (cerca de ${n})` : '') });
    }
  }
  let resto: unknown[] = [];
  if (!primeros.length && busca.length >= 3) {
    const [g, p] = await Promise.all([georef(busca, foco).catch(() => [] as Lugar[]), pelias(busca, params)]);
    if (delLink) g.forEach(x => { x.label += ' (del link)'; });
    primeros.push(...g);
    // deno-lint-ignore no-explicit-any
    resto = p.filter((f: any) => {
      const [lo, la] = f.geometry?.coordinates || [];
      return !primeros.some(x => metros(x.lon, x.lat, lo, la) < 60);
    });
  }
  return { type: 'FeatureCollection', features: [...primeros.map(feature), ...resto].slice(0, 10) };
}

const supabase = createClient(Deno.env.get('SUPABASE_URL')!, (Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_ANON_KEY'))!, { auth: { persistSession: false } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: { message: 'Método no permitido' } }, 405);
  if (!KEY) return json({ error: { message: 'Falta cargar la clave de rutas en el servidor (secreto ORS_KEY).' } }, 500);

  // ¿Quién pide? Tiene que ser alguien que entró a la app.
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: who, error: authErr } = token ? await supabase.auth.getUser(token) : { data: null, error: true };
  if (authErr || !who?.user) return json({ error: { message: 'Tenés que entrar a la app.' } }, 401);
  // Solo cuentas de la empresa (con perfil): una cuenta suelta no gasta la cuota de rutas
  const { data: perfil } = await supabase.from('perfiles').select('id').eq('id', who.user.id).maybeSingle();
  if (!perfil) return json({ error: { message: 'Esta cuenta no es de la empresa.' } }, 403);

  const raw = await req.text();
  if (raw.length > 300_000) return json({ error: { message: 'Pedido demasiado grande' } }, 413);
  let msg: { op?: string; body?: unknown; params?: Record<string, unknown>; elegir?: boolean; camion?: { largo?: number; peso?: number } };
  try { msg = JSON.parse(raw); } catch { return json({ error: { message: 'Pedido inválido' } }, 400); }

  const op = msg.op as keyof typeof PATHS;
  if (!(op in PATHS)) return json({ error: { message: 'Operación desconocida' } }, 400);

  let upstream: Response;
  try {
    if (op === 'directions') {
      const post = (b: unknown) => fetch(BASE + PATHS.directions, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json', Authorization: KEY },
        body: JSON.stringify(b),
      });
      // deno-lint-ignore no-explicit-any
      let body = (msg.body ?? {}) as any;
      // Zonas prohibidas para este camión: se suman a las que ya se esquivan
      let zs: { evitar: Zona[]; dentro: Zona[]; avisos: Zona[] } = { evitar: [], dentro: [], avisos: [] };
      try { zs = zonasPara(await cargarZonas(), msg.camion, body.coordinates || []); } catch { /* sin zonas */ }
      const sinZonas = body;
      if (zs.evitar.length) {
        const prev = body.options?.avoid_polygons;
        const polys = prev ? (prev.type === 'MultiPolygon' ? prev.coordinates : [prev.coordinates]) : [];
        body = { ...body, options: { ...(body.options || {}), avoid_polygons: { type: 'MultiPolygon', coordinates: [...polys, ...zs.evitar.map(z => [z.anillo])] } } };
      }
      const infoZonas = { evitadas: zs.evitar.map(z => z.nombre), dentro: zs.dentro.map(z => ({ nombre: z.nombre, nota: z.nota, fuente: z.fuente })),
        avisos: zs.avisos.map(z => ({ nombre: z.nombre, nota: z.nota, fuente: z.fuente })) };
      if (!(msg as { elegir?: boolean }).elegir) {
        upstream = await post(body);
        if (!upstream.ok && zs.evitar.length) { await upstream.body?.cancel(); upstream = await post(sinZonas); infoZonas.evitadas = []; }
      }
      else {
        const extra = [...new Set([...(body.extra_info || []), 'waytype'])];
        upstream = await post({ ...body, extra_info: extra, alternative_routes: { target_count: 3, share_factor: 0.6, weight_factor: 1.6 } });
        // Caminos alternativos solo hasta ~100 km: si no se puede, se pide uno solo
        if (!upstream.ok) { await upstream.body?.cancel(); upstream = await post({ ...body, extra_info: extra }); }
        // Si con las zonas prohibidas no hay camino, se pide sin ellas (y no se informan como evitadas)
        if (!upstream.ok && zs.evitar.length) { await upstream.body?.cancel(); upstream = await post({ ...sinZonas, extra_info: extra }); infoZonas.evitadas = []; }
        if (upstream.ok) {
          const d = await upstream.json();
          if (Array.isArray(d.features) && d.features.length) {
            let r: Red | null = null; try { r = await cargarRed(); } catch { /* sin red: se elige solo por avenidas */ }
            const vac: Red = { grid: new Map(), zonas: [], caja: [0, 0, 0, 0], caba: [] };
            const bitren = Number((msg as { camion?: { largo?: number } }).camion?.largo) >= 22.4;
            const notas = d.features.map((f: unknown) => puntuar(f, r || vac, bitren));
            let mejor = 0; notas.forEach((n: { costo: number }, i: number) => { if (n.costo < notas[mejor].costo) mejor = i; });
            const elegida = d.features[mejor];
            elegida.properties.eleccion = { ...notas[mejor], opciones: d.features.length, mejorQueLaPrimera: mejor !== 0 };
            elegida.properties.zonas = infoZonas;
            // Barrios populares (registro oficial RENABAP) a menos de 150 m del camino elegido: la app avisa al acercarse
            try {
              const { data: bp } = await supabase.rpc('barrios_en_ruta', { linea: elegida.geometry });
              elegida.properties.precaucion = bp || [];
            } catch { elegida.properties.precaucion = []; }
            // Peajes y puestos de control (sanitarios, aduanas, balanzas) sobre el camino, en orden
            try {
              const { data: pr } = await supabase.rpc('puntos_en_ruta', { linea: elegida.geometry });
              elegida.properties.puntos = pr || [];
            } catch { elegida.properties.puntos = []; }
            // Restricciones de la ANSV que caen en el horario del viaje (si sale ahora)
            try { elegida.properties.ansv = ansvEnRuta(await cargarAnsv(), elegida.geometry?.coordinates || [], elegida.properties?.summary?.duration || 0); }
            catch { elegida.properties.ansv = []; }
            // Alertas del SMN (tormentas, viento, Zonda, nieve, niebla…) en las zonas que cruza el camino,
            // solo si rigen cuando el camión pasa por ahí (saliendo ahora, a la velocidad que calcula la ruta)
            try {
              const { data: cl } = await supabase.rpc('clima_en_ruta', { linea: elegida.geometry });
              const dist = elegida.properties?.summary?.distance || 0, dur = elegida.properties?.summary?.duration || 0, t0 = Date.now();
              const cuando = (m: number) => t0 + (dist > 0 ? m / dist * dur * 1000 : 0);
              elegida.properties.clima = (cl || []).map((a: { entra: number; sale: number; desde: string | null; hasta: string | null }) => {
                const te = cuando(a.entra), ts = cuando(a.sale) + 3600_000;   // una hora de margen por demoras
                return { ...a, llega: new Date(te).toISOString(), rige: (!a.desde || Date.parse(a.desde) <= ts) && (!a.hasta || Date.parse(a.hasta) >= te) };
              }).filter((a: { rige: boolean }) => a.rige);
            } catch { elegida.properties.clima = []; }
            d.features = [elegida, ...d.features.filter((_: unknown, i: number) => i !== mejor)];
          }
          return new Response(JSON.stringify(d), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
        }
      }
    } else if (op === 'search') {
      try { return json(await buscar(msg.params)); }
      catch (e) {
        if ((e as Error).message === 'clave') return json({ error: { code: 'clave', message: 'La clave de rutas del servidor no es válida. Avisale al dueño.' } }, 502);
        return json({ error: { message: 'El buscador no respondió.' } }, 502);
      }
    } else {
      const u = new URL(BASE + PATHS[op]);
      for (const k of PARAMS) { const v = msg.params?.[k]; if (v != null && v !== '') u.searchParams.set(k, String(v).slice(0, 200)); }
      u.searchParams.set('api_key', KEY);
      upstream = await fetch(u, { headers: { Accept: 'application/json', Authorization: KEY } });
    }
  } catch (_e) {
    return json({ error: { message: 'El servicio de rutas no respondió.' } }, 502);
  }

  // Si HeiGIT rechaza la clave, lo tiene que arreglar el dueño (el chofer no la ve).
  if (upstream.status === 401 || upstream.status === 403) {
    return json({ error: { code: 'clave', message: 'La clave de rutas del servidor no es válida. Avisale al dueño.' } }, 502);
  }
  // Lo demás se devuelve tal cual (incluye los códigos de error de openrouteservice: 2004, 2009, 2010…)
  const text = await upstream.text();
  return new Response(text, { status: upstream.status, headers: { ...CORS, 'Content-Type': 'application/json' } });
});
