package ar.camiones.auto

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin
import kotlin.math.sqrt

data class Geo(val lat: Double, val lon: Double)

object G {
    fun dist(a: Geo, b: Geo): Double {
        val r = PI / 180
        val x = (b.lon - a.lon) * r * cos((a.lat + b.lat) / 2 * r)
        val y = (b.lat - a.lat) * r
        return sqrt(x * x + y * y) * 6371000
    }

    fun rumbo(a: Geo, b: Geo): Double {
        val r = PI / 180
        val y = sin((b.lon - a.lon) * r) * cos(b.lat * r)
        val x = cos(a.lat * r) * sin(b.lat * r) - sin(a.lat * r) * cos(b.lat * r) * cos((b.lon - a.lon) * r)
        return (atan2(y, x) / r + 360) % 360
    }

    /** Distancia de p al segmento a-b (metros) y posición t (0..1) sobre el segmento. */
    fun alSegmento(p: Geo, a: Geo, b: Geo): Pair<Double, Double> {
        val kx = cos(p.lat * PI / 180) * 111320
        val ky = 110540.0
        val ax = (a.lon - p.lon) * kx; val ay = (a.lat - p.lat) * ky
        val bx = (b.lon - p.lon) * kx; val by = (b.lat - p.lat) * ky
        val vx = bx - ax; val vy = by - ay
        val l = vx * vx + vy * vy
        val t = if (l > 0) (-(ax * vx + ay * vy) / l).coerceIn(0.0, 1.0) else 0.0
        return Pair(hypot(ax + t * vx, ay + t * vy), t)
    }
}

/** Medidas del camión (las mismas que carga el dueño en el panel). */
data class Camion(
    val id: String?, val nombre: String, val alto: Double, val peso: Double, val largo: Double,
    val ancho: Double, val eje: Double, val peligrosa: Boolean, val ejes: Int?,
) {
    companion object {
        /** Si el chofer no tiene camión asignado: un semirremolque común. */
        val PorDefecto = Camion(null, "Camión", 4.1, 45.0, 20.0, 2.6, 10.5, false, null)

        fun desde(j: JSONObject): Camion {
            fun num(k: String, def: Double) = if (j.isNull(k)) def else j.optDouble(k, def)
            return Camion(
                j.texto("id"), j.texto("nombre").ifEmpty { "Camión" }, num("alto", 4.1), num("peso", 45.0),
                num("largo", 20.0), num("ancho", 2.6), num("eje", 10.5), j.optBoolean("peligrosa", false),
                if (j.isNull("ejes")) null else j.optInt("ejes"),
            )
        }
    }
}

data class Destino(val nombre: String, val detalle: String, val geo: Geo, val viajeId: String? = null)

/** Un paso de la ruta (maniobra). tipo = tipo de instrucción de openrouteservice. */
class Paso(val tipo: Int, val instruccion: String, val calle: String, val desde: Int, val salida: Int)

/** Peaje o puesto de control sobre el camino (lo devuelve la función rutas). */
class Punto(val clase: String, val id: String, val tipo: String, val nombre: String, val geo: Geo, val tarifas: JSONObject?, val metros: Double) {
    /** Tarifa según los ejes del camión: la categoría más alta que no pasa sus ejes (o la mayor si no se sabe). */
    fun tarifa(ejes: Int?): Double? {
        val t = tarifas ?: return null
        val ks = t.keys().asSequence().filter { k -> k.isNotEmpty() && k.all { it.isDigit() } }.map { it.toInt() }.sorted().toList()
        if (ks.isEmpty()) return null
        val k = if (ejes != null) ks.lastOrNull { it <= ejes } ?: ks.first() else ks.last()
        return t.optDouble(k.toString()).takeIf { !it.isNaN() }
    }
}

class AlertaClima(val evento: String, val nivel: String, val entra: Double, val sale: Double, val hasta: String)

class Ruta(
    val coords: List<Geo>, val pasos: List<Paso>, val distancia: Double, val duracion: Double,
    val puntos: List<Punto>, val clima: List<AlertaClima>, val precaucion: List<Geo>,
) {
    /** Metros acumulados desde la salida hasta cada punto del dibujo. */
    val cum: DoubleArray = DoubleArray(coords.size).also { c -> for (i in 1 until coords.size) c[i] = c[i - 1] + G.dist(coords[i - 1], coords[i]) }
    val total: Double get() = if (cum.isEmpty()) 0.0 else cum.last()

    fun metrosDe(indice: Int): Double = cum[indice.coerceIn(0, cum.size - 1)]

    companion object {
        fun desde(d: JSONObject): Ruta {
            val fs = d.optJSONArray("features") ?: throw Exception("No encontré una ruta posible para este camión.")
            if (fs.length() == 0) throw Exception("No encontré una ruta posible para este camión.")
            val f = fs.getJSONObject(0)
            val cs = f.getJSONObject("geometry").getJSONArray("coordinates")
            val coords = (0 until cs.length()).map { val c = cs.getJSONArray(it); Geo(c.getDouble(1), c.getDouble(0)) }
            val pr = f.getJSONObject("properties")
            val pasos = mutableListOf<Paso>()
            val segs = pr.optJSONArray("segments") ?: JSONArray()
            for (i in 0 until segs.length()) {
                val st = segs.getJSONObject(i).optJSONArray("steps") ?: continue
                for (k in 0 until st.length()) {
                    val s = st.getJSONObject(k)
                    val wp = s.getJSONArray("way_points")
                    pasos += Paso(s.optInt("type", 6), s.texto("instruction"), s.texto("name").let { if (it == "-") "" else it },
                        wp.getInt(0), s.optInt("exit_number", 0))
                }
            }
            val sum = pr.optJSONObject("summary") ?: JSONObject()
            val puntos = mutableListOf<Punto>()
            pr.optJSONArray("puntos")?.let { a ->
                for (i in 0 until a.length()) {
                    val p = a.getJSONObject(i)
                    puntos += Punto(p.texto("clase"), p.texto("id"), p.texto("tipo"), p.texto("nombre"),
                        Geo(p.getDouble("lat"), p.getDouble("lon")), p.optJSONObject("tarifas"), p.optDouble("metros", 0.0))
                }
            }
            val clima = mutableListOf<AlertaClima>()
            pr.optJSONArray("clima")?.let { a ->
                for (i in 0 until a.length()) {
                    val c = a.getJSONObject(i)
                    clima += AlertaClima(c.texto("evento"), c.texto("nivel"), c.optDouble("entra", 0.0), c.optDouble("sale", 0.0), c.texto("hasta"))
                }
            }
            val prec = mutableListOf<Geo>()
            pr.optJSONArray("precaucion")?.let { a ->
                for (i in 0 until a.length()) {
                    val b = a.getJSONObject(i)
                    if (!b.isNull("lat") && !b.isNull("lon")) prec += Geo(b.getDouble("lat"), b.getDouble("lon"))
                }
            }
            return Ruta(coords, pasos, sum.optDouble("distance", 0.0), sum.optDouble("duration", 0.0), puntos, clima, prec)
        }
    }
}
