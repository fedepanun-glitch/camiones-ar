// Conexión con el proyecto "camiones-ar" de Supabase (Project Settings → API).
// Estos dos datos son públicos: los permisos los controlan las reglas de la base y las funciones del servidor.
// La clave de rutas NO va acá: se guarda en el servidor (secreto ORS_KEY de la función "rutas").
window.CAMIONES_NUBE = {
  url: '',      // https://xxxxxxxx.supabase.co
  anonKey: '',  // clave "anon" / "publishable"
};
