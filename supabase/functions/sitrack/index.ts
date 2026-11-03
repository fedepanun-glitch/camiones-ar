// Camiones AR — función "sitrack".
// Cada minuto (reloj automático de la base) pide a Sitrack la última posición de todas las unidades de la cuenta,
// la guarda en la tabla "rastreo" asociada a cada camión por la patente y genera alertas de velocidad.
// Documentación: "SITRACK-Integración de consulta de último reporte (polling)" + "Autenticación Basic HTTPS".
// Usuario y contraseña de API de Sitrack: secretos SITRACK_USER y SITRACK_PASS (nunca en el código ni en el celular).
import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

const USER = Deno.env.get('SITRACK_USER') || '';
const PASS = Deno.env.get('SITRACK_PASS') || '';
const PAIS = (Deno.env.get('SITRACK_PAIS') || 'ar').toLowerCase();       // ar | br | cl | mx | uy
const TEST = Deno.env.get('SITRACK_TEST') === '1';                       // ambiente de pruebas de Sitrack
const URL_REPORT = `https://${TEST ? 'test-' : ''}externalappgw.${PAIS}.sitrack.com/v2/report`;
const FRESCO_MS = 5 * 60 * 1000;      // para alertas: solo reportes de los últimos 5 minutos
const ENTRE_ALERTAS_MS = 10 * 60 * 1000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const norm = (s: unknown) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

type Reporte = Record<string, unknown>;
// Sitrack entrega JSON; según la cuenta puede venir como lista o como objetos separados por ",\n"
function parsear(texto: string): Reporte[] {
  const t = texto.trim();
  if (!t) return [];
  let d: unknown;
  try { d = JSON.parse(t); } catch { d = JSON.parse('[' + t.replace(/,\s*$/, '') + ']'); }
  if (Array.isArray(d)) return d as Reporte[];
  const o = d as Record<string, unknown>;
  for (const k of ['data', 'reports', 'items', 'results']) if (Array.isArray(o?.[k])) return o[k] as Reporte[];
  return o && typeof o === 'object' ? [o] : [];
}
const num = (v: unknown) => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '')); return Number.isFinite(n) ? n : null; };

async function guardarEstado(ok: boolean, mensaje: string, unidades: number | null = null, sinAsociar: string[] | null = null) {
  await admin.from('sitrack_estado').upsert({ id: 1, ok, mensaje, unidades, sin_asociar: sinAsociar, at: new Date().toISOString() });
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);

  // Lo dispara el reloj de la base (con su contraseña interna) o el dueño desde el panel ("Probar ahora")
  const cron = req.headers.get('x-cron-token') || '';
  let permitido = false;
  if (cron) {
    const { data: tok } = await admin.rpc('sitrack_token');
    permitido = !!tok && cron === tok;
  } else {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await admin.auth.getUser(token) : { data: null };
    if (who?.user) {
      const { data: yo } = await admin.from('perfiles').select('rol').eq('id', who.user.id).maybeSingle();
      permitido = yo?.rol === 'dueno';
    }
  }
  if (!permitido) return json({ error: 'No autorizado' }, 401);

  if (!USER || !PASS) {
    await guardarEstado(false, 'Faltan cargar el usuario y la contraseña de API de Sitrack (secretos SITRACK_USER y SITRACK_PASS).');
    return json({ ok: false, error: 'Faltan SITRACK_USER y SITRACK_PASS' }, 200);
  }

  // 1) Pedir a Sitrack la última posición de todas las unidades
  let res: Response, texto: string;
  try {
    res = await fetch(URL_REPORT, {
      headers: { Authorization: 'Basic ' + btoa(`${USER}:${PASS}`), Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
    texto = await res.text();
  } catch (_e) {
    await guardarEstado(false, 'Sitrack no respondió (sin conexión o demora). Se reintenta en un minuto.');
    return json({ ok: false, error: 'Sitrack no respondió' }, 502);
  }
  if (!res.ok) {
    let msg = `Sitrack respondió ${res.status}.`;
    try {
      const e = JSON.parse(texto);
      if (e.errorCode === 117) { return json({ ok: false, error: 'Consulta muy seguida, se saltea' }, 200); } // límite de frecuencia
      msg = `Sitrack: ${e.userMessage || msg}${e.errorCode ? ` (código ${e.errorCode})` : ''}`;
    } catch { /* respuesta no JSON */ }
    if (res.status === 401 || res.status === 403) msg += ' Revisá el usuario y la contraseña de API de Sitrack.';
    await guardarEstado(false, msg);
    return json({ ok: false, error: msg }, 502);
  }

  let reportes: Reporte[];
  try { reportes = parsear(texto); } catch {
    await guardarEstado(false, 'Sitrack respondió en un formato que no se pudo leer.');
    return json({ ok: false, error: 'Formato desconocido', muestra: texto.slice(0, 300) }, 502);
  }

  // 2) Asociar cada unidad con su camión (por patente; si no tiene patente cargada, por el nombre)
  const [{ data: camiones }, { data: aj }, { data: viajes }] = await Promise.all([
    admin.from('camiones').select('id, nombre, patente').eq('activo', true),
    admin.from('ajustes').select('velocidad_max').eq('id', 1).maybeSingle(),
    admin.from('viajes').select('id, chofer_id, camion_id').eq('estado', 'en_curso'),
  ]);
  const porPatente = new Map<string, string>();
  for (const c of camiones || []) {
    if (c.patente) porPatente.set(norm(c.patente), c.id);
    else if (norm(c.nombre)) porPatente.set(norm(c.nombre), c.id);
  }
  const limite = aj?.velocidad_max ?? 80;

  const filas = [], sinAsociar: string[] = [], alertas = [];
  for (const r of reportes) {
    const asset = String(r.assetId ?? '').trim();
    const lat = num(r.latitude), lon = num(r.longitude);
    if (!asset || lat === null || lon === null) continue; // sin señal satelital: se guarda la posición anterior
    const camionId = porPatente.get(norm(asset)) ?? null;
    if (!camionId) sinAsociar.push(asset);
    const vel = num(r.speed);
    const at = r.reportDate ? new Date(String(r.reportDate)).toISOString() : new Date().toISOString();
    filas.push({
      asset_id: asset, camion_id: camionId, nombre: r.assetName ? String(r.assetName) : null,
      lat, lon, velocidad: vel, rumbo: num(r.heading), direccion: r.location ? String(r.location).slice(0, 200) : null,
      encendido: r.ignition == null ? null : Number(r.ignition) === 1, evento: r.eventName ? String(r.eventName) : null,
      reporte_at: at, actualizado: new Date().toISOString(),
    });
    if (vel !== null && vel > limite && Date.now() - new Date(at).getTime() < FRESCO_MS) {
      const viaje = (viajes || []).find(v => v.camion_id && v.camion_id === camionId);
      alertas.push({ asset_id: asset, camion_id: camionId, chofer_id: viaje?.chofer_id ?? null, viaje_id: viaje?.id ?? null,
        velocidad: vel, limite, lat, lon, origen: 'satelital', at });
    }
  }
  if (filas.length) {
    const { error } = await admin.from('rastreo').upsert(filas, { onConflict: 'asset_id' });
    if (error) { await guardarEstado(false, 'No se pudieron guardar las posiciones: ' + error.message); return json({ ok: false, error: error.message }, 500); }
  }

  // 3) Alertas de velocidad (una cada 10 minutos por camión como máximo)
  let nuevas = 0;
  for (const a of alertas) {
    const { data: ult } = await admin.from('alertas').select('at').eq('asset_id', a.asset_id).order('at', { ascending: false }).limit(1).maybeSingle();
    if (ult && Date.now() - new Date(ult.at).getTime() < ENTRE_ALERTAS_MS) continue;
    const { error } = await admin.from('alertas').insert(a);
    if (!error) nuevas++;
  }

  const msg = `${filas.length} unidades actualizadas` + (sinAsociar.length ? `; ${sinAsociar.length} sin camión asociado` : '');
  await guardarEstado(true, msg, filas.length, sinAsociar);
  return json({ ok: true, unidades: filas.length, sinAsociar, alertas: nuevas });
});
