package ar.camiones.auto

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Algo en el camino: un puente con límite (Vialidad), un corte o puente bajo marcado por los choferes,
 * una calle bloqueada por la empresa o cualquier otro reporte. evitar = la ruta tiene que esquivarlo.
 */
class Obstaculo(val id: String, val geo: Geo, val texto: String, val voz: String, val evitar: Boolean, val tipo: String)

/** Un obstáculo que quedó sobre la ruta elegida, con los metros desde la salida. */
class ObstaculoEnRuta(val o: Obstaculo, val metros: Double)

object Avisos {
    private fun num(v: Double) = if (v == v.roundToInt().toDouble()) v.roundToInt().toString() else String.format(java.util.Locale.forLanguageTag("es-AR"), "%.1f", v)

    /** Restricciones oficiales con ubicación (puentes con límite de peso, alturas, prohibiciones). */
    fun oficiales(a: JSONArray, c: Camion): List<Obstaculo> = (0 until a.length()).mapNotNull { i ->
        val o = a.getJSONObject(i)
        if (o.isNull("lat") || o.isNull("lon")) return@mapNotNull null
        val g = Geo(o.getDouble("lat"), o.getDouble("lon"))
        val valor = if (o.isNull("valor")) null else o.optDouble("valor")
        val eje = if (o.isNull("valor_eje")) null else o.optDouble("valor_eje")
        val donde = listOf(o.texto("ruta"), o.texto("nombre")).filter { it.isNotEmpty() }.joinToString(" ")
        when (o.texto("tipo")) {
            "peso", "peso_eje" -> {
                val partes = mutableListOf<String>()
                if (valor != null) partes += "${num(valor)} t"
                if (eje != null) partes += "${num(eje)} t por eje"
                val noPasa = (valor != null && valor < c.peso) || (eje != null && eje < c.eje)
                Obstaculo("of" + o.texto("id"), g, "Puente con límite de ${partes.joinToString(" y ")}" + if (donde.isNotEmpty()) " ($donde)" else "",
                    "Puente con límite de ${partes.joinToString(" y ").replace(" t", " toneladas")}", noPasa, "puente")
            }
            "altura" -> if (valor == null) null else Obstaculo("of" + o.texto("id"), g, "Altura máxima ${num(valor)} m",
                "Altura máxima ${num(valor).replace(".", " coma ")} metros", valor < c.alto, "altura")
            "largo" -> if (valor == null) null else Obstaculo("of" + o.texto("id"), g, "Largo máximo ${num(valor)} m",
                "Largo máximo ${num(valor).replace(".", " coma ")} metros", valor < c.largo, "largo")
            "prohibido_camiones" -> Obstaculo("of" + o.texto("id"), g, "Prohibido camiones" + if (donde.isNotEmpty()) " ($donde)" else "",
                "Paso prohibido para camiones", true, "prohibido")
            // Cualquier otro tipo (p. ej. puente clausurado) se esquiva, como en la app web
            else -> Obstaculo("of" + o.texto("id"), g, "Clausurado" + if (donde.isNotEmpty()) " ($donde)" else "",
                "Atención. Paso clausurado", true, "clausurado")
        }
    }

    private val REP = mapOf(
        "bache" to "Bache", "camino_roto" to "Camino roto", "control" to "Control", "balanza" to "Balanza", "corte" to "Corte",
        "altura" to "Puente bajo", "angosta" to "Calle angosta", "inseguro" to "Zona insegura", "otro" to "Atención",
    )

    /** Reportes de los choferes que siguen activos. */
    fun reportes(a: JSONArray, c: Camion): List<Obstaculo> = (0 until a.length()).mapNotNull { i ->
        val r = a.getJSONObject(i)
        if (r.isNull("lat") || r.isNull("lon")) return@mapNotNull null
        val tipo = r.texto("tipo")
        val dato = if (r.isNull("dato")) null else r.optDouble("dato")
        val nombre = REP[tipo] ?: "Atención"
        val g = Geo(r.getDouble("lat"), r.getDouble("lon"))
        when (tipo) {
            "corte" -> Obstaculo("r" + r.texto("id"), g, "Corte marcado por otro chofer", "Atención. Corte marcado por otro chofer", true, tipo)
            "altura" -> {
                // Solo importa si el camión no pasa (o no se sabe la altura)
                if (dato != null && c.alto < dato - 0.1) null
                else Obstaculo("r" + r.texto("id"), g, "Puente bajo" + (dato?.let { " de ${num(it)} m" } ?: ""),
                    "Atención. Puente bajo" + (dato?.let { " de ${num(it).replace(".", " coma ")} metros" } ?: ""), true, tipo)
            }
            "inseguro" -> Obstaculo("r" + r.texto("id"), g, "Zona insegura: no te detengas",
                "Precaución. Zona insegura marcada por otros choferes. No te detengas", false, tipo)
            else -> Obstaculo("r" + r.texto("id"), g, nombre, "Atención. $nombre", false, tipo)
        }
    }

    /** Calles marcadas como "No puedo pasar" por la empresa. */
    fun bloqueos(a: JSONArray): List<Obstaculo> = (0 until a.length()).mapNotNull { i ->
        val b = a.getJSONObject(i)
        if (b.isNull("lat") || b.isNull("lon")) null
        else Obstaculo("b" + b.texto("id"), Geo(b.getDouble("lat"), b.getDouble("lon")),
            "Calle bloqueada" + b.texto("calle").let { if (it.isNotEmpty()) ": $it" else "" }, "Atención. Calle bloqueada", true, "bloqueo")
    }

    /** Cuadraditos de ~80 m alrededor de cada punto a esquivar, cerca del viaje (como la app web). */
    fun poligonos(evitar: List<Geo>, desde: Geo, hasta: Geo): JSONObject? {
        val m = 0.3
        // Los que están pegados a la salida o a la llegada no se esquivan (el servicio no encontraría camino), solo se avisan
        val cerca = evitar.filter {
            it.lat in min(desde.lat, hasta.lat) - m..max(desde.lat, hasta.lat) + m &&
                it.lon in min(desde.lon, hasta.lon) - m..max(desde.lon, hasta.lon) + m &&
                G.dist(it, desde) > 150 && G.dist(it, hasta) > 150
        }.take(400)
        if (cerca.isEmpty()) return null
        val polys = JSONArray()
        for (g in cerca) {
            val dy = 0.00035
            val dx = 0.00035 / kotlin.math.cos(g.lat * Math.PI / 180)
            fun p(x: Double, y: Double) = JSONArray().put(x).put(y)
            polys.put(JSONArray().put(JSONArray()
                .put(p(g.lon - dx, g.lat - dy)).put(p(g.lon + dx, g.lat - dy)).put(p(g.lon + dx, g.lat + dy))
                .put(p(g.lon - dx, g.lat + dy)).put(p(g.lon - dx, g.lat - dy))))
        }
        return JSONObject().put("type", "MultiPolygon").put("coordinates", polys)
    }

    /** Obstáculos a menos de 40 m del camino, en orden. */
    fun enRuta(r: Ruta, todos: List<Obstaculo>): List<ObstaculoEnRuta> {
        if (r.coords.size < 2 || todos.isEmpty()) return emptyList()
        val la0 = r.coords.minOf { it.lat } - 0.01; val la1 = r.coords.maxOf { it.lat } + 0.01
        val lo0 = r.coords.minOf { it.lon } - 0.01; val lo1 = r.coords.maxOf { it.lon } + 0.01
        val out = mutableListOf<ObstaculoEnRuta>()
        for (o in todos) {
            if (o.geo.lat !in la0..la1 || o.geo.lon !in lo0..lo1) continue
            var mejor = Double.MAX_VALUE; var metros = 0.0
            for (i in 0 until r.coords.size - 1) {
                val a = r.coords[i]; val b = r.coords[i + 1]
                if (o.geo.lat < min(a.lat, b.lat) - 0.001 || o.geo.lat > max(a.lat, b.lat) + 0.001 ||
                    o.geo.lon < min(a.lon, b.lon) - 0.001 || o.geo.lon > max(a.lon, b.lon) + 0.001) continue
                val (d, t) = G.alSegmento(o.geo, a, b)
                if (d < mejor) { mejor = d; metros = r.cum[i] + t * (r.cum[i + 1] - r.cum[i]) }
            }
            if (mejor < 40) out += ObstaculoEnRuta(o, metros)
        }
        return out.sortedBy { it.metros }
    }
}

/**
 * Precio de un peaje para este camión, como la app web: según los ejes, el sentido (p. ej. Hudson cobra doble hacia
 * Capital, y si ya pagaste en Dock Sud no cobra), y la hora pico a la hora en que el camión llega (feriado = domingo).
 */
class Precio(val valor: Double?, val pagadoEn: String?, val pico: Boolean)

object Peajes {
    private val OBELISCO = Geo(-34.6037, -58.3816)
    private val ZONA = ZoneId.of("America/Argentina/Buenos_Aires")

    private fun puntoEn(r: Ruta, m: Double): Int { var i = 0; while (i < r.cum.size - 1 && r.cum[i] < m) i++; return i }

    private fun rumboEn(r: Ruta, m: Double): Double {
        val i = puntoEn(r, m)
        return G.rumbo(r.coords[max(0, i - 1)], r.coords[min(r.coords.size - 1, i + 1)])
    }

    private fun factorSentido(p: Punto, r: Ruta): Pair<Double, String?> {
        val reglas = p.tarifas?.optJSONArray("sentidos") ?: return Pair(1.0, null)
        if (reglas.length() == 0 || r.coords.size < 2) return Pair(1.0, null)
        val rumbo = rumboEn(r, p.metros)
        fun dif(x: Double) = kotlin.math.abs(((x - rumbo + 540) % 360) - 180)
        val g = (0 until reglas.length()).map { reglas.getJSONObject(it) }
            .filter { dif(it.optDouble("rumbo")) < 90 }.minByOrNull { dif(it.optDouble("rumbo")) } ?: return Pair(1.0, null)
        val si = g.texto("si_paso")
        if (si.isNotEmpty()) {
            val antes = r.puntos.firstOrNull { it.id == si && it.metros < p.metros }
            if (antes != null) return Pair(g.optDouble("factor_si_paso", 0.0), antes.nombre)
        }
        return Pair(g.optDouble("factor", 1.0), null)
    }

    private fun esPico(p: Punto, r: Ruta, llegaMs: Long, feriados: Set<String>): Boolean {
        val pc = p.tarifas?.optJSONObject("pico") ?: return false
        val franjas = pc.optJSONArray("franjas") ?: return false
        val t = Instant.ofEpochMilli(llegaMs).atZone(ZONA)
        val dia = if (feriados.contains(t.toLocalDate().toString())) 7 else t.dayOfWeek.value
        val min = t.hour * 60 + t.minute
        fun mm(s: String): Int { val x = s.split(":"); return x[0].toInt() * 60 + (x.getOrNull(1)?.toIntOrNull() ?: 0) }
        var hacia: String? = null
        for (i in 0 until franjas.length()) {
            val f = franjas.getJSONObject(i)
            val dias = f.optJSONArray("dias")
            if (dias != null && (0 until dias.length()).none { dias.getInt(it) == dia }) continue
            val horas = f.optJSONArray("horas") ?: continue
            if ((0 until horas.length()).none { val h = horas.getJSONArray(it); min >= mm(h.getString(0)) && min < mm(h.getString(1)) }) continue
            val quiere = f.texto("hacia")
            if (quiere.isEmpty()) return true
            if (hacia == null) {
                val a = r.coords[puntoEn(r, p.metros)]; val b = r.coords[puntoEn(r, p.metros + 600)]
                hacia = if (G.dist(b, OBELISCO) < G.dist(a, OBELISCO)) "caba" else "provincia"
            }
            if (quiere == hacia) return true
        }
        return false
    }

    /** hecho = metros ya recorridos (0 en la vista previa). */
    fun precio(p: Punto, r: Ruta, ejes: Int?, hecho: Double, feriados: Set<String>): Precio {
        val base = p.tarifa(ejes) ?: return Precio(null, null, false)
        val (f, pagado) = factorSentido(p, r)
        if (pagado != null) return Precio(0.0, pagado, false)
        val falta = max(0.0, p.metros - hecho)
        val llega = System.currentTimeMillis() + (if (r.total > 0) r.duracion * 1000 * falta / r.total else 0.0).toLong()
        val pico = esPico(p, r, llega, feriados)
        val fp = if (pico) p.tarifas?.optJSONObject("pico")?.optDouble("factor", 1.0) ?: 1.0 else 1.0
        return Precio(base * f * fp, null, pico)
    }
}
