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
  let msg: { op?: string; body?: unknown; params?: Record<string, unknown>; elegir?: boolean; camion?: { largo?: number } };
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
      const body = (msg.body ?? {}) as any;
      if (!(msg as { elegir?: boolean }).elegir) upstream = await post(body);
      else {
        const extra = [...new Set([...(body.extra_info || []), 'waytype'])];
        upstream = await post({ ...body, extra_info: extra, alternative_routes: { target_count: 3, share_factor: 0.6, weight_factor: 1.6 } });
        // Caminos alternativos solo hasta ~100 km: si no se puede, se pide uno solo
        if (!upstream.ok) { await upstream.body?.cancel(); upstream = await post({ ...body, extra_info: extra }); }
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
            d.features = [elegida, ...d.features.filter((_: unknown, i: number) => i !== mejor)];
          }
          return new Response(JSON.stringify(d), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } });
        }
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
