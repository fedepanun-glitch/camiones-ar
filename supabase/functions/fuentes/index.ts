// Camiones AR — función "fuentes".
// Descarga documentos oficiales (normas, anexos en PDF, páginas, planillas), extrae el texto y lo guarda en
// la tabla "fuentes_docs", para cargar restricciones con su fuente. Solo sitios del gobierno (.gob.ar) y una
// lista permitida. La usa el reloj interno de la base (contraseña interna) o el dueño/administrador.
import { createClient } from 'npm:@supabase/supabase-js@2.110.0';
import { extractText, getDocumentProxy } from 'npm:unpdf@0.12.1';

const PERMITIDOS = ['bccba.org.ar', 'www.bccba.org.ar'];
const permitido = (h: string) => h.endsWith('.gob.ar') || h === 'gob.ar' || PERMITIDOS.includes(h);
const MAX = 25 * 1024 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-cron-token',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

function deHtml(html: string, base: string) {
  const enlaces: { texto: string; url: string }[] = [];
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    try { enlaces.push({ url: new URL(m[1], base).href, texto: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) }); } catch { /* nada */ }
  }
  const titulo = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').replace(/\s+/g, ' ').trim();
  const texto = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { titulo, texto, enlaces };
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Método no permitido' }, 405);
  // Permiso: reloj interno o dueño/administrador completo
  let ok = false;
  const cron = req.headers.get('x-cron-token') || '';
  if (cron) { const { data: tok } = await admin.rpc('sitrack_token'); ok = !!tok && cron === tok; }
  else {
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data: who } = token ? await admin.auth.getUser(token) : { data: null };
    if (who?.user) { const { data: yo } = await admin.from('perfiles').select('rol, solo_lectura').eq('id', who.user.id).maybeSingle(); ok = (yo?.rol === 'dueno' || yo?.rol === 'admin') && !yo?.solo_lectura; }
  }
  if (!ok) return json({ error: 'No autorizado' }, 401);

  let pedido: { url?: string; guardar?: boolean };
  try { pedido = await req.json(); } catch { return json({ error: 'Pedido inválido' }, 400); }
  let u: URL;
  try { u = new URL(String(pedido.url)); } catch { return json({ error: 'URL inválida' }, 400); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return json({ error: 'URL inválida' }, 400);
  if (!permitido(u.hostname)) return json({ error: 'Sitio no permitido: ' + u.hostname }, 403);

  let res: Response;
  try { res = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0 (CamionesAR; gestion de flota)', Accept: '*/*' }, redirect: 'follow', signal: AbortSignal.timeout(60000) }); }
  catch (e) { return json({ error: 'No respondió: ' + (e as Error).message }, 502); }
  const final = new URL(res.url || u.href);
  if (!permitido(final.hostname)) return json({ error: 'Redirigió a un sitio no permitido: ' + final.hostname }, 403);
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length > MAX) return json({ error: 'Documento demasiado grande' }, 413);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const esPdf = ct.includes('pdf') || (buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46);

  let fila: Record<string, unknown>;
  if (esPdf) {
    try {
      const pdf = await getDocumentProxy(buf);
      const { text, totalPages } = await extractText(pdf, { mergePages: false });
      const paginas = Array.isArray(text) ? text : [String(text)];
      fila = { tipo: 'pdf', titulo: `PDF de ${totalPages} páginas`, texto: paginas.map((t, i) => `--- página ${i + 1} ---\n${t}`).join('\n'), enlaces: null };
    } catch (e) { return json({ error: 'No se pudo leer el PDF: ' + (e as Error).message }, 422); }
  } else {
    const txt = new TextDecoder('utf-8').decode(buf);
    if (ct.includes('html') || /^\s*<(!doctype|html)/i.test(txt)) { const h = deHtml(txt, final.href); fila = { tipo: 'html', titulo: h.titulo, texto: h.texto, enlaces: h.enlaces }; }
    else fila = { tipo: ct.includes('json') ? 'json' : ct.includes('csv') ? 'csv' : 'texto', titulo: null, texto: txt, enlaces: null };
  }
  // Para documentos escaneados (tablas como imagen) se guarda también el archivo original
  if (pedido.guardar) { let b = ''; for (let i = 0; i < buf.length; i += 0x8000) b += String.fromCharCode(...buf.subarray(i, i + 0x8000)); fila.archivo_b64 = btoa(b); }
  const { error } = await admin.from('fuentes_docs').upsert({ url: u.href, ...fila, bytes: buf.length, estado: res.status, at: new Date().toISOString() });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, url: u.href, tipo: fila.tipo, estado: res.status, largo: String(fila.texto || '').length });
});
