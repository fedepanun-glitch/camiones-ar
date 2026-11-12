// Camiones AR — función "clima".
// Copia las alertas meteorológicas vigentes del Servicio Meteorológico Nacional (SMN) a la tabla "alertas_clima".
// Fuente: listado oficial CAP del SMN (https://ssl.smn.gob.ar/CAP/AR.php, licencia CC BY 4.0). Cada alerta trae
// el polígono de la zona, el horario y la severidad. Lo que ya no figura en el listado se borra (terminó o se reemplazó).
// La usa el reloj interno de la base cada 15 minutos (contraseña interna) o el dueño/administrador.
import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

const LISTADO = 'https://ssl.smn.gob.ar/CAP/AR.php';
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const UA = { 'User-Agent': 'Mozilla/5.0 (CamionesAR; gestion de flota)', Accept: '*/*' };

const texto = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
const tag = (xml: string, t: string) => { const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')); return m ? texto(m[1]) : null; };
const NIVEL: Record<string, string> = { Minor: 'amarilla', Moderate: 'amarilla', Severe: 'naranja', Extreme: 'roja' };

// "lat,lon lat,lon …" (CAP) → anillo WKT "lon lat, …" cerrado; null si no sirve
function anillo(p: string) {
  const pts = p.trim().split(/\s+/).map(x => x.split(',').map(Number)).filter(x => x.length === 2 && x.every(Number.isFinite));
  if (pts.length < 3) return null;
  if (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1]) pts.push(pts[0]);
  if (pts.length < 4) return null;
  return '((' + pts.map(([la, lo]) => `${lo} ${la}`).join(', ') + '))';
}

function leer(url: string, xml: string) {
  if (!/<alert\b/i.test(xml)) return null;
  const tipo = tag(xml, 'msgType');
  if (tipo === 'Cancel') return null;
  const info = xml.match(/<info>([\s\S]*?)<\/info>/i)?.[1] || '';
  const polis: string[] = [];
  for (const m of info.matchAll(/<polygon>([\s\S]*?)<\/polygon>/gi)) { const a = anillo(m[1]); if (a) polis.push(a); }
  if (!polis.length) return null;
  const sev = tag(info, 'severity') || '';
  return {
    url,
    identificador: tag(xml, 'identifier'),
    evento: tag(info, 'event') || tag(info, 'headline') || 'Alerta',
    nivel: NIVEL[sev] || null,
    severidad: sev || null,
    desde: tag(info, 'onset') || tag(info, 'effective') || tag(xml, 'sent'),
    hasta: tag(info, 'expires'),
    descripcion: tag(info, 'description'),
    instruccion: tag(info, 'instruction'),
    area: 'SRID=4326;MULTIPOLYGON(' + polis.join(', ') + ')',
    at: new Date().toISOString(),
  };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  let ok = false;
  const cron = req.headers.get('x-cron-token') || '';
  if (cron) { const { data: tok } = await admin.rpc('sitrack_token'); ok = !!tok && cron === tok; }
  else {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await admin.auth.getUser(token) : { data: null };
    if (who?.user) { const { data: yo } = await admin.from('perfiles').select('rol, solo_lectura').eq('id', who.user.id).maybeSingle(); ok = (yo?.rol === 'dueno' || yo?.rol === 'admin') && !yo?.solo_lectura; }
  }
  if (!ok) return json({ error: 'No autorizado' }, 401);

  // 1) Listado de alertas vigentes
  let pagina: string;
  try {
    const r = await fetch(LISTADO, { headers: UA, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return json({ error: 'El SMN respondió ' + r.status }, 502);
    pagina = await r.text();
  } catch (e) { return json({ error: 'El SMN no respondió: ' + (e as Error).message }, 502); }
  if (!/CAP/i.test(pagina)) return json({ error: 'Listado del SMN con formato desconocido' }, 502);
  const urls = [...new Set([...pagina.matchAll(/https?:\/\/ssl\.smn\.gob\.ar\/[^"'\s<>]+\.xml/gi)].map(m => m[0].replace(/^http:/, 'https:')))].slice(0, 300);

  // 2) Se bajan solo las que no están guardadas (de a 4, con pausa, para no cargar al SMN)
  const { data: ya } = await admin.from('alertas_clima').select('url');
  const tengo = new Set((ya || []).map(x => x.url as string));
  const nuevas = urls.filter(u => !tengo.has(u));
  const filas: Record<string, unknown>[] = [];
  let fallas = 0;
  for (let i = 0; i < nuevas.length; i += 4) {
    await Promise.all(nuevas.slice(i, i + 4).map(async u => {
      try {
        const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(20000) });
        if (!r.ok) { fallas++; return; }
        const f = leer(u, await r.text()); if (f) filas.push(f);
      } catch { fallas++; }
    }));
    await new Promise(r => setTimeout(r, 200));
  }
  if (filas.length) {
    const { error } = await admin.from('alertas_clima').upsert(filas);
    if (error) return json({ error: error.message }, 500);
  }
  // 3) Lo que ya no figura en el listado, se borra (solo si el listado se leyó bien)
  let borradas = 0;
  const viejas = [...tengo].filter(u => !urls.includes(u));
  if (viejas.length) { const { count } = await admin.from('alertas_clima').delete({ count: 'exact' }).in('url', viejas); borradas = count || 0; }
  return json({ ok: true, listadas: urls.length, nuevas: filas.length, fallas, borradas });
});
