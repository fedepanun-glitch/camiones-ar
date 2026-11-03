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
  let msg: { op?: string; body?: unknown; params?: Record<string, unknown> };
  try { msg = JSON.parse(raw); } catch { return json({ error: { message: 'Pedido inválido' } }, 400); }

  const op = msg.op as keyof typeof PATHS;
  if (!(op in PATHS)) return json({ error: { message: 'Operación desconocida' } }, 400);

  let upstream: Response;
  try {
    if (op === 'directions') {
      upstream = await fetch(BASE + PATHS.directions, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/geo+json, application/json', Authorization: KEY },
        body: JSON.stringify(msg.body ?? {}),
      });
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
