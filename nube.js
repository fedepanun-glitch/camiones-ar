/* Camiones AR — conexión con la nube (Supabase), compartida por la app del chofer y el panel del dueño.
   Si nube-config.js está vacío, la app sigue andando sola en el celular, como antes. */
(() => {
  'use strict';
  const C = window.CAMIONES_NUBE || {};
  const configurada = !!(C.url && C.anonKey && window.supabase);
  // Tienen que coincidir con supabase/functions/choferes/index.ts
  const DOMINIO = 'choferes.camiones-ar.invalid';
  const limpiarUsuario = u => String(u ?? '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.');
  const claveDe = pin => `CamionesAR-${pin}-chofer`;

  const sb = configurada ? window.supabase.createClient(C.url, C.anonKey, {
    // La sesión queda guardada en el celular y se renueva sola: el chofer entra una sola vez.
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'camionesar.sesion' },
  }) : null;

  let perfil = null;

  async function sesion() {
    if (!sb) return null;
    const { data } = await sb.auth.getSession();
    return data.session || null;
  }

  async function cargarPerfil(force) {
    if (!sb) return null;
    if (perfil && !force) return perfil;
    const s = await sesion(); if (!s) { perfil = null; return null; }
    const { data, error } = await sb.from('perfiles').select('*').eq('id', s.user.id).maybeSingle();
    if (error) {
      // Sin señal: usar el último perfil conocido
      try { const p = JSON.parse(localStorage.getItem('camionesar.perfil') || 'null'); if (p && p.id === s.user.id) return (perfil = p); } catch (e) { /* nada */ }
      throw error;
    }
    perfil = data;
    try { localStorage.setItem('camionesar.perfil', JSON.stringify(data)); } catch (e) { /* nada */ }
    return perfil;
  }

  // Chofer: usuario + PIN. Dueño: email + contraseña.
  async function entrar(usuarioOEmail, pinOClave) {
    const u = String(usuarioOEmail || '').trim();
    const esEmail = u.includes('@');
    const email = esEmail ? u.toLowerCase() : `${limpiarUsuario(u)}@${DOMINIO}`;
    const password = esEmail ? String(pinOClave) : claveDe(String(pinOClave).trim());
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      const msg = /invalid login|credentials/i.test(error.message) ? (esEmail ? 'Email o contraseña incorrectos.' : 'Usuario o PIN incorrectos.')
        : /fetch|network/i.test(error.message) ? 'No hay señal. Probá de nuevo cuando haya internet.'
        : /rate|too many/i.test(error.message) ? 'Demasiados intentos. Esperá unos minutos.' : error.message;
      throw new Error(msg);
    }
    const p = await cargarPerfil(true);
    if (!p) { await sb.auth.signOut(); throw new Error('Esta cuenta no tiene perfil en la empresa. Pedile al dueño que la revise.'); }
    return p;
  }

  async function salir() {
    perfil = null;
    try { localStorage.removeItem('camionesar.perfil'); } catch (e) { /* nada */ }
    if (sb) await sb.auth.signOut({ scope: 'local' });
  }

  // Llama a una función del servidor (rutas, choferes). Devuelve { ok, status, data }.
  async function funcion(nombre, cuerpo) {
    const s = await sesion();
    if (!s) return { ok: false, status: 401, data: { error: { message: 'Tenés que entrar a la app.' } } };
    const res = await fetch(`${C.url.replace(/\/+$/, '')}/functions/v1/${nombre}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.access_token}`, apikey: C.anonKey },
      body: JSON.stringify(cuerpo),
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  // Formato común para camiones (la app usa nombres cortos)
  const camionApp = c => ({ id: c.id, name: c.nombre, h: +c.alto, w: +c.peso, l: +c.largo, wd: +c.ancho, e: +c.eje, hz: !!c.peligrosa, ej: c.ejes ? +c.ejes : null });

  window.Nube = {
    configurada, sb, DOMINIO, limpiarUsuario, sesion, cargarPerfil, entrar, salir, funcion, camionApp,
    get perfil() { return perfil; },
  };
})();
