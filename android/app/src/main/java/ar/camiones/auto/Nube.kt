package ar.camiones.auto

import android.content.Context
import android.content.SharedPreferences
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.Normalizer
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Conexión con el proyecto "camiones-ar" de Supabase: la misma cuenta, los mismos datos y la misma función
 * de rutas que la app web. La URL y la clave publishable son públicas (los permisos los controla la base).
 * La clave de rutas (HeiGIT) NO está acá: la usa el servidor.
 */
object Nube {
    private const val URL = "https://ttfndzxsaoycmzsjycwe.supabase.co"
    private const val CLAVE = "sb_publishable_4gqKzoJh5GuInJaiz4LVTA_6v66odOe"
    // Tienen que coincidir con nube.js y supabase/functions/choferes/index.ts
    private const val DOMINIO = "choferes.camiones-ar.invalid"

    private val http = OkHttpClient.Builder().callTimeout(90, TimeUnit.SECONDS).build()
    private val JSON_TIPO = "application/json".toMediaType()
    private lateinit var prefs: SharedPreferences

    fun init(ctx: Context) {
        if (!::prefs.isInitialized) prefs = ctx.applicationContext.getSharedPreferences("nube", Context.MODE_PRIVATE)
    }

    val conectado: Boolean get() = prefs.getString("refresh", null) != null
    val uid: String? get() = prefs.getString("uid", null)
    val nombre: String? get() = prefs.getString("nombre", null)

    private class Resp(val code: Int, val body: String)

    private fun limpiarUsuario(u: String): String =
        Normalizer.normalize(u.trim().lowercase(), Normalizer.Form.NFD).replace(Regex("\\p{Mn}+"), "").replace(Regex("\\s+"), ".")

    private fun pedir(metodo: String, ruta: String, cuerpo: String?, token: String?, extra: Map<String, String> = emptyMap()): Resp {
        val b = Request.Builder().url(URL + ruta).header("apikey", CLAVE)
        if (token != null) b.header("Authorization", "Bearer $token")
        extra.forEach { (k, v) -> b.header(k, v) }
        val rb = cuerpo?.toRequestBody(JSON_TIPO)
        b.method(metodo, rb ?: if (metodo == "GET") null else "".toRequestBody(JSON_TIPO))
        http.newCall(b.build()).execute().use { r -> return Resp(r.code, r.body?.string() ?: "") }
    }

    private fun guardar(j: JSONObject) {
        val ahora = System.currentTimeMillis() / 1000
        prefs.edit()
            .putString("access", j.getString("access_token"))
            .putString("refresh", j.getString("refresh_token"))
            .putLong("vence", j.optLong("expires_at", ahora + j.optLong("expires_in", 3600)))
            .putString("uid", j.optJSONObject("user")?.optString("id") ?: uid)
            .apply()
    }

    /** Token vigente (lo renueva si está por vencer). */
    private fun token(): String {
        val ahora = System.currentTimeMillis() / 1000
        val access = prefs.getString("access", null)
        if (access != null && prefs.getLong("vence", 0) - 120 > ahora) return access
        val refresh = prefs.getString("refresh", null) ?: throw Exception("Tenés que entrar a la app en el celular.")
        val r = pedir("POST", "/auth/v1/token?grant_type=refresh_token", JSONObject().put("refresh_token", refresh).toString(), null)
        if (r.code == 400 || r.code == 401) { prefs.edit().clear().apply(); throw Exception("La sesión venció. Entrá de nuevo en el celular.") }
        if (r.code != 200) throw Exception("Sin conexión con el servidor (${r.code}).")
        guardar(JSONObject(r.body))
        return prefs.getString("access", null)!!
    }

    /** Chofer: usuario + PIN. Dueño: email + contraseña (igual que la app web). */
    suspend fun entrar(usuario: String, clave: String): JSONObject = withContext(Dispatchers.IO) {
        val esEmail = usuario.contains("@")
        val email = if (esEmail) usuario.trim().lowercase() else "${limpiarUsuario(usuario)}@$DOMINIO"
        val pass = if (esEmail) clave else "CamionesAR-${clave.trim()}-chofer"
        val r = pedir("POST", "/auth/v1/token?grant_type=password", JSONObject().put("email", email).put("password", pass).toString(), null)
        if (r.code == 400) throw Exception(if (esEmail) "Email o contraseña incorrectos." else "Usuario o PIN incorrectos.")
        if (r.code == 429) throw Exception("Demasiados intentos. Esperá unos minutos.")
        if (r.code != 200) throw Exception("No se pudo entrar (${r.code}). Revisá la señal.")
        guardar(JSONObject(r.body))
        val p = perfilSinContexto() ?: run { salirLocal(); throw Exception("Esta cuenta no tiene perfil en la empresa.") }
        prefs.edit().putString("nombre", p.optString("nombre")).putString("camion_id", p.texto("camion_id")).apply()
        p
    }

    suspend fun salir() = withContext(Dispatchers.IO) {
        runCatching { pedir("POST", "/auth/v1/logout", "{}", token()) }
        salirLocal()
    }

    private fun salirLocal() { prefs.edit().clear().apply() }

    private fun perfilSinContexto(): JSONObject? {
        val r = pedir("GET", "/rest/v1/perfiles?select=*&id=eq.$uid", null, token())
        if (r.code != 200) throw Exception("No se pudo leer el perfil (${r.code}).")
        val a = JSONArray(r.body)
        return if (a.length() > 0) a.getJSONObject(0) else null
    }

    private fun lista(ruta: String): JSONArray {
        val r = pedir("GET", ruta, null, token())
        if (r.code != 200) throw Exception("No se pudieron leer los datos (${r.code}).")
        return JSONArray(r.body)
    }

    /** El camión asignado al chofer (o null). */
    suspend fun camion(): Camion? = withContext(Dispatchers.IO) {
        val p = perfilSinContexto() ?: return@withContext null
        prefs.edit().putString("nombre", p.optString("nombre")).apply()
        val id = p.texto("camion_id").ifEmpty { return@withContext null }
        val a = lista("/rest/v1/camiones?select=*&id=eq.$id")
        if (a.length() > 0) Camion.desde(a.getJSONObject(0)) else null
    }

    /** Viajes pendientes o en curso del chofer, con el destino. */
    suspend fun viajes(): List<Destino> = withContext(Dispatchers.IO) {
        val a = lista("/rest/v1/viajes?select=id,fecha,estado,notas,destino:destino_id(nombre,direccion,lat,lon)" +
            "&chofer_id=eq.$uid&estado=in.(pendiente,en_curso)&order=fecha.asc&limit=20")
        (0 until a.length()).mapNotNull { i ->
            val v = a.getJSONObject(i)
            val d = v.optJSONObject("destino") ?: return@mapNotNull null
            if (d.isNull("lat") || d.isNull("lon")) return@mapNotNull null
            val estado = if (v.texto("estado") == "en_curso") "En curso" else "Para el ${v.texto("fecha")}"
            Destino(d.texto("nombre").ifEmpty { "Destino" }, listOf(estado, d.texto("direccion")).filter { it.isNotEmpty() }.joinToString(" · "),
                Geo(d.getDouble("lat"), d.getDouble("lon")), v.texto("id"))
        }
    }

    /** Lugares guardados de la empresa (clientes, depósitos, estaciones…). */
    suspend fun lugares(): List<Destino> = withContext(Dispatchers.IO) {
        val a = lista("/rest/v1/lugares?select=id,nombre,tipo,direccion,lat,lon&order=nombre.asc&limit=200")
        (0 until a.length()).mapNotNull { i ->
            val l = a.getJSONObject(i)
            if (l.isNull("lat") || l.isNull("lon")) null
            else Destino(l.texto("nombre"), l.texto("direccion"), Geo(l.getDouble("lat"), l.getDouble("lon")))
        }
    }

    private fun funcion(nombre: String, cuerpo: JSONObject): JSONObject {
        val r = pedir("POST", "/functions/v1/$nombre", cuerpo.toString(), token())
        val j = runCatching { JSONObject(r.body) }.getOrElse { JSONObject() }
        if (r.code !in 200..299) {
            val err = j.optJSONObject("error")
            val code = err?.opt("code")
            throw Exception(when {
                r.code == 429 -> "Se alcanzó el límite de rutas gratis de hoy. Probá de nuevo mañana."
                code == 2010 -> "No hay una calle para camión cerca del punto de salida o de llegada."
                code == 2009 || code == 2099 -> "No encontré una ruta posible para este camión."
                code == 2004 -> "El viaje es muy largo para calcularlo de una vez. Elegí un destino intermedio."
                err?.optString("message").isNullOrEmpty().not() -> err!!.optString("message")
                else -> "El servicio de rutas no respondió (${r.code})."
            })
        }
        return j
    }

    /** Busca direcciones y lugares (el mismo buscador que la app web). */
    suspend fun buscar(texto: String, cerca: Geo?): List<Destino> = withContext(Dispatchers.IO) {
        val params = JSONObject().put("text", texto).put("size", 8).put("boundary.country", "AR").put("lang", "es")
        if (cerca != null) params.put("focus.point.lat", cerca.lat).put("focus.point.lon", cerca.lon)
        val d = funcion("rutas", JSONObject().put("op", "search").put("params", params))
        val fs = d.optJSONArray("features") ?: JSONArray()
        (0 until fs.length()).map { i ->
            val f = fs.getJSONObject(i)
            val c = f.getJSONObject("geometry").getJSONArray("coordinates")
            val p = f.getJSONObject("properties")
            Destino(p.texto("name").ifEmpty { p.texto("label") }, p.texto("label"), Geo(c.getDouble(1), c.getDouble(0)))
        }
    }

    /** Ruta para camión (perfil HGV, zonas prohibidas, peajes, alertas…), igual que la app web. */
    suspend fun ruta(desde: Geo, hasta: Geo, c: Camion): Ruta = withContext(Dispatchers.IO) {
        val restr = JSONObject().put("height", c.alto).put("weight", c.peso).put("length", c.largo).put("width", c.ancho)
            .put("axleload", c.eje).put("hazmat", c.peligrosa)
        val body = JSONObject()
            .put("coordinates", JSONArray().put(JSONArray().put(desde.lon).put(desde.lat)).put(JSONArray().put(hasta.lon).put(hasta.lat)))
            .put("language", "es").put("instructions", true).put("units", "m")
            .put("radiuses", JSONArray().put(2000).put(2000))
            .put("options", JSONObject().put("vehicle_type", "hgv").put("profile_params", JSONObject().put("restrictions", restr)))
        val d = funcion("rutas", JSONObject().put("op", "directions").put("elegir", true)
            .put("camion", JSONObject().put("largo", c.largo).put("peso", c.peso)).put("body", body))
        Ruta.desde(d)
    }

    /** Manda la ubicación al panel del dueño (misma tabla que la app web). */
    suspend fun posicion(p: Geo, kmh: Double, rumbo: Double, precision: Double, camionId: String?, destino: String?) = withContext(Dispatchers.IO) {
        val u = uid ?: return@withContext
        val j = JSONObject().put("chofer_id", u).put("lat", p.lat).put("lon", p.lon).put("velocidad", kmh).put("rumbo", rumbo)
            .put("precision_m", precision).put("at", Instant.now().toString())
            .put("camion_id", camionId ?: JSONObject.NULL).put("destino", destino ?: JSONObject.NULL)
        runCatching {
            pedir("POST", "/rest/v1/posiciones?on_conflict=chofer_id", j.toString(), token(),
                mapOf("Prefer" to "resolution=merge-duplicates,return=minimal"))
        }
    }
}

/** optString devuelve "null" para los nulos de JSON: esto devuelve "". */
fun JSONObject.texto(k: String): String = if (isNull(k)) "" else optString(k, "")
