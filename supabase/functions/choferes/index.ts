// Camiones AR — función "choferes".
// El dueño (o un administrador) da de alta, cambia el PIN o da de baja a un chofer.
// Solo el dueño crea o borra administradores (entran al panel con email y contraseña).
// Cada chofer entra con "usuario" + PIN; por dentro es una cuenta de Supabase con un email interno.
import { createClient } from 'npm:@supabase/supabase-js@2.110.0';

// Tienen que coincidir con nube.js
const DOMINIO = 'choferes.camiones-ar.invalid';
const emailDe = (usuario: string) => `${usuario}@${DOMINIO}`;
const claveDe = (pin: string) => `CamionesAR-${pin}-chofer`;
const limpiarUsuario = (u: unknown) => String(u ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.');
const usuarioOk = (u: string) => /^[a-z0-9][a-z0-9._-]{2,29}$/.test(u);
const pinOk = (p: unknown) => typeof p === 'string' && /^\d{4,8}$/.test(p);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const fail = (message: string, status = 400) => json({ error: { message } }, status);

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return fail('Método no permitido', 405);

  // Solo el dueño
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: who } = token ? await admin.auth.getUser(token) : { data: null };
  if (!who?.user) return fail('Tenés que entrar como dueño.', 401);
  const { data: yo } = await admin.from('perfiles').select('rol').eq('id', who.user.id).maybeSingle();
  if (yo?.rol !== 'dueno' && yo?.rol !== 'admin') return fail('Solo el dueño o un administrador puede manejar choferes.', 403);

  let m: Record<string, unknown>;
  try { m = await req.json(); } catch { return fail('Pedido inválido'); }

  // ---- Administradores (solo el dueño) ----
  if (m.accion === 'crear_admin' || m.accion === 'borrar_admin' || m.accion === 'clave_admin') {
    if (yo?.rol !== 'dueno') return fail('Solo el dueño puede manejar administradores.', 403);
    if (m.accion === 'crear_admin') {
      const nombre = String(m.nombre ?? '').trim().slice(0, 80), email = String(m.email ?? '').trim().toLowerCase(), clave = String(m.clave ?? '');
      if (!nombre) return fail('Falta el nombre.');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail('El email no es válido.');
      if (clave.length < 8) return fail('La contraseña tiene que tener al menos 8 caracteres.');
      const { data, error } = await admin.auth.admin.createUser({ email, password: clave, email_confirm: true, user_metadata: { nombre, rol: 'admin' } });
      if (error || !data.user) return fail('No se pudo crear: ' + (error?.message || 'error desconocido'), 500);
      const { error: e2 } = await admin.from('perfiles').insert({ id: data.user.id, nombre, email, rol: 'admin' });
      if (e2) { await admin.auth.admin.deleteUser(data.user.id); return fail('No se pudo crear: ' + e2.message, 500); }
      return json({ ok: true, id: data.user.id });
    }
    const aid = String(m.id ?? '');
    const { data: ad } = await admin.from('perfiles').select('rol').eq('id', aid).maybeSingle();
    if (ad?.rol !== 'admin') return fail('Administrador no encontrado.', 404);
    if (m.accion === 'clave_admin') {
      const clave = String(m.clave ?? '');
      if (clave.length < 8) return fail('La contraseña tiene que tener al menos 8 caracteres.');
      const { error } = await admin.auth.admin.updateUserById(aid, { password: clave });
      if (error) return fail(error.message, 500);
      await admin.rpc('cerrar_sesiones', { p_user: aid });
      return json({ ok: true });
    }
    const { error } = await admin.auth.admin.deleteUser(aid);
    if (error) return fail(error.message, 500);
    return json({ ok: true });
  }

  if (m.accion === 'crear') {
    const usuario = limpiarUsuario(m.usuario), nombre = String(m.nombre ?? '').trim().slice(0, 80);
    if (!nombre) return fail('Falta el nombre.');
    if (!usuarioOk(usuario)) return fail('El usuario tiene que tener de 3 a 30 letras o números, sin espacios.');
    if (!pinOk(m.pin)) return fail('El PIN tiene que tener de 4 a 8 números.');
    const { data: dup } = await admin.from('perfiles').select('id').eq('usuario', usuario).maybeSingle();
    if (dup) return fail('Ya hay un chofer con ese usuario.');
    const { data, error } = await admin.auth.admin.createUser({
      email: emailDe(usuario), password: claveDe(m.pin as string), email_confirm: true,
      user_metadata: { nombre, rol: 'chofer' },
    });
    if (error || !data.user) return fail('No se pudo crear: ' + (error?.message || 'error desconocido'), 500);
    const { error: e2 } = await admin.from('perfiles').insert({
      id: data.user.id, nombre, usuario, rol: 'chofer',
      camion_id: m.camion_id || null, telefono: m.telefono ? String(m.telefono).slice(0, 40) : null,
    });
    if (e2) { await admin.auth.admin.deleteUser(data.user.id); return fail('No se pudo crear: ' + e2.message, 500); }
    return json({ ok: true, id: data.user.id, usuario });
  }

  // Para lo demás, el chofer tiene que existir y ser chofer (el dueño no se toca desde acá)
  const id = String(m.id ?? '');
  const { data: ch } = await admin.from('perfiles').select('id, rol, usuario').eq('id', id).maybeSingle();
  if (!ch || ch.rol !== 'chofer') return fail('Chofer no encontrado.', 404);

  if (m.accion === 'pin') {
    if (!pinOk(m.pin)) return fail('El PIN tiene que tener de 4 a 8 números.');
    const { error } = await admin.auth.admin.updateUserById(id, { password: claveDe(m.pin as string) });
    if (error) return fail(error.message, 500);
    // Cierra la sesión en el celular viejo: tiene que volver a entrar con el PIN nuevo
    await admin.rpc('cerrar_sesiones', { p_user: id });
    return json({ ok: true });
  }

  if (m.accion === 'usuario') {
    const usuario = limpiarUsuario(m.usuario);
    if (!usuarioOk(usuario)) return fail('El usuario tiene que tener de 3 a 30 letras o números, sin espacios.');
    const { data: dup } = await admin.from('perfiles').select('id').eq('usuario', usuario).neq('id', id).maybeSingle();
    if (dup) return fail('Ya hay un chofer con ese usuario.');
    const { error } = await admin.auth.admin.updateUserById(id, { email: emailDe(usuario), email_confirm: true });
    if (error) return fail(error.message, 500);
    await admin.from('perfiles').update({ usuario }).eq('id', id);
    return json({ ok: true, usuario });
  }

  if (m.accion === 'cerrar') {
    // Desconecta al chofer de todos sus celulares (por ejemplo, si lo perdió)
    const { error } = await admin.rpc('cerrar_sesiones', { p_user: id });
    if (error) return fail(error.message, 500);
    return json({ ok: true });
  }

  if (m.accion === 'borrar') {
    const { error } = await admin.auth.admin.deleteUser(id); // borra también su perfil y su ubicación
    if (error) return fail(error.message, 500);
    return json({ ok: true });
  }

  return fail('Acción desconocida');
});
