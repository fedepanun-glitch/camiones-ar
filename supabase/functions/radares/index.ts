// Camiones AR — función "radares".
// Trae de OpenStreetMap las fotomultas (cámaras de velocidad) de Argentina y las guarda en la tabla "radares".
// La dispara el dueño o un administrador desde el panel ("Traer de OpenStreetMap").
// Datos © colaboradores de OpenStreetMap, licencia ODbL.
import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
// Rectángulo que cubre Argentina (más rápido que buscar por el "área" del país)
const QUERY = `[out:json][timeout:100][bbox:-55.2,-73.6,-21.7,-53.5];
(
  node["highway"="speed_camera"];
  relation["type"="enforcement"]["enforcement"~"^(maxspeed|average_speed)$"];
);
out body;
>;
out skel qt;`;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

// "60", "60 km/h", "AR:urban"… → número de km/h (o null)
export function velocidad(v: unknown): number | null {
  const m = String(v ?? '').match(/\d{2,3}/);
  if (!m) return null;
  const n = parseInt(m[0], 10);
  return n >= 10 && n <= 150 ? n : null;
}
// "90", "NE"… → grados (o null si no se sabe / ambos sentidos)
const PUNTOS: Record<string, number> = { N: 0, NE: 45, E: 90, SE: 135, S: 180, SO: 225, SW: 225, O: 270, W: 270, NO: 315, NW: 315 };
export function rumbo(v: unknown): number | null {
  const s = String(v ?? '').trim().toUpperCase();
  if (!s) return null;
  if (s in PUNTOS) return PUNTOS[s];
  const n = parseFloat(s);
  return Number.isFinite(n) && !s.includes(';') ? ((n % 360) + 360) % 360 : null;
}
const dentro = (lat: number, lon: number) => lat >= -56 && lat <= -21 && lon >= -74 && lon <= -53;

type El = { type: string; id: number; lat?: number; lon?: number; tags?: Record<string, string>; members?: { type: string; ref: number; role: string }[] };
export function convertir(elements: El[]) {
  const nodos = new Map<number, El>();
  for (const e of elements) if (e.type === 'node') nodos.set(e.id, e);
  const out = new Map<string, Record<string, unknown>>();
  const usados = new Set<number>();
  // Relaciones de control de velocidad: el "device" es la cámara, el límite está en la relación
  for (const r of elements.filter(e => e.type === 'relation')) {
    const dev = (r.members || []).find(m => m.type === 'node' && m.role === 'device') || (r.members || []).find(m => m.type === 'node' && (m.role === 'from' || m.role === 'to'));
    const n = dev && nodos.get(dev.ref);
    if (!n || n.lat == null || n.lon == null || !dentro(n.lat, n.lon)) continue;
    const max = velocidad(r.tags?.maxspeed) ?? velocidad(n.tags?.maxspeed);
    usados.add(n.id);
    out.set('r' + r.id, { osm_id: 'r' + r.id, lat: n.lat, lon: n.lon, maxima: max, rumbo: rumbo(n.tags?.direction), tipo: 'fotomulta', fuente: 'osm', activo: true, creado_por: null });
  }
  // Cámaras sueltas (nodo highway=speed_camera)
  for (const n of nodos.values()) {
    if (n.tags?.highway !== 'speed_camera' || usados.has(n.id) || n.lat == null || n.lon == null || !dentro(n.lat, n.lon)) continue;
    out.set('n' + n.id, { osm_id: 'n' + n.id, lat: n.lat, lon: n.lon, maxima: velocidad(n.tags?.maxspeed), rumbo: rumbo(n.tags?.direction), tipo: 'fotomulta', fuente: 'osm', activo: true, creado_por: null });
  }
  return [...out.values()];
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: who } = token ? await admin.auth.getUser(token) : { data: null };
  if (!who?.user) return json({ error: 'Tenés que entrar al panel.' }, 401);
  const { data: yo } = await admin.from('perfiles').select('rol').eq('id', who.user.id).maybeSingle();
  if (yo?.rol !== 'dueno' && yo?.rol !== 'admin') return json({ error: 'Solo el dueño o un administrador.' }, 403);

  // 1) Pedir a OpenStreetMap (Overpass) todas las fotomultas de Argentina
  let datos: { elements?: El[] } | null = null, ultimoError = '';
  for (const url of OVERPASS) {
    try {
      const r = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: QUERY }), signal: AbortSignal.timeout(110000),
        headers: { 'User-Agent': 'CamionesAR/1.0 (gestion de flota)' } });
      if (!r.ok) { ultimoError = `OpenStreetMap respondió ${r.status}`; continue; }
      datos = await r.json(); break;
    } catch (e) { ultimoError = 'OpenStreetMap no respondió (' + (e as Error).message + ')'; }
  }
  if (!datos?.elements) return json({ error: ultimoError || 'OpenStreetMap no respondió' }, 502);

  // 2) Guardar (actualiza las que ya estaban; no toca las cargadas a mano)
  const filas = convertir(datos.elements);
  for (let i = 0; i < filas.length; i += 500) {
    const { error } = await admin.from('radares').upsert(filas.slice(i, i + 500), { onConflict: 'osm_id' });
    if (error) return json({ error: 'No se pudieron guardar: ' + error.message }, 500);
  }
  // Las que ya no están en OpenStreetMap se desactivan
  const vigentes = new Set(filas.map(f => f.osm_id as string));
  const { data: viejas } = await admin.from('radares').select('id, osm_id').eq('fuente', 'osm').eq('activo', true);
  const bajas = (viejas || []).filter(v => !vigentes.has(v.osm_id)).map(v => v.id);
  if (bajas.length) await admin.from('radares').update({ activo: false }).in('id', bajas);

  return json({ ok: true, total: filas.length, conMaxima: filas.filter(f => f.maxima != null).length, desactivadas: bajas.length });
});
