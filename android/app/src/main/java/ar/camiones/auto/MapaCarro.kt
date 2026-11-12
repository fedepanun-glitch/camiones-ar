package ar.camiones.auto

import android.app.Presentation
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import androidx.car.app.CarContext
import androidx.car.app.SurfaceCallback
import androidx.car.app.SurfaceContainer
import org.maplibre.android.MapLibre
import org.maplibre.android.camera.CameraPosition
import org.maplibre.android.camera.CameraUpdateFactory
import org.maplibre.android.geometry.LatLng
import org.maplibre.android.geometry.LatLngBounds
import org.maplibre.android.maps.MapLibreMap
import org.maplibre.android.maps.MapLibreMapOptions
import org.maplibre.android.maps.MapView
import org.maplibre.android.maps.Style
import org.maplibre.android.style.layers.CircleLayer
import org.maplibre.android.style.layers.LineLayer
import org.maplibre.android.style.layers.Property
import org.maplibre.android.style.layers.PropertyFactory
import org.maplibre.android.style.sources.GeoJsonSource
import org.maplibre.geojson.Feature
import org.maplibre.geojson.LineString
import org.maplibre.geojson.Point

/**
 * Dibuja el mapa en la pantalla del auto. Android Auto le da a la app una "superficie" (Surface); el mapa de
 * MapLibre se muestra en una pantalla virtual que dibuja sobre esa superficie. Mismo estilo que la app web.
 */
class MapaCarro(private val ctx: CarContext) : SurfaceCallback {
    companion object { const val ESTILO = "https://tiles.openfreemap.org/styles/liberty" }

    private var pantalla: VirtualDisplay? = null
    private var presentacion: Presentation? = null
    private var vista: MapView? = null
    private var mapa: MapLibreMap? = null
    private var estilo: Style? = null
    private var ancho = 0
    private var alto = 0
    private var visible: Rect? = null

    private var ruta: List<Geo>? = null
    private var pos: Geo? = null
    private var rumbo = 0.0
    private var siguiendo = false
    private var encuadrar = false

    override fun onSurfaceAvailable(contenedor: SurfaceContainer) {
        val superficie = contenedor.surface ?: return
        liberar()
        ancho = contenedor.width; alto = contenedor.height
        MapLibre.getInstance(ctx)
        val dm = ctx.getSystemService(DisplayManager::class.java)
        val vd = dm.createVirtualDisplay("camiones-ar-mapa", ancho, alto, contenedor.dpi, superficie,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY)
        val p = Presentation(ctx, vd.display)
        val opciones = MapLibreMapOptions.createFromAttributes(p.context).textureMode(true)
            .logoEnabled(false).attributionEnabled(false).compassEnabled(false)
        val mv = MapView(p.context, opciones)
        mv.onCreate(null)
        p.setContentView(mv)
        p.show()
        mv.onStart(); mv.onResume()
        mv.getMapAsync { m ->
            mapa = m
            m.setStyle(Style.Builder().fromUri(ESTILO)) { st ->
                estilo = st
                st.addSource(GeoJsonSource("ruta"))
                st.addLayer(LineLayer("ruta-borde", "ruta").withProperties(
                    PropertyFactory.lineColor("#ffffff"), PropertyFactory.lineWidth(11f),
                    PropertyFactory.lineCap(Property.LINE_CAP_ROUND), PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND)))
                st.addLayer(LineLayer("ruta", "ruta").withProperties(
                    PropertyFactory.lineColor("#1f6feb"), PropertyFactory.lineWidth(7f),
                    PropertyFactory.lineCap(Property.LINE_CAP_ROUND), PropertyFactory.lineJoin(Property.LINE_JOIN_ROUND)))
                st.addSource(GeoJsonSource("camion"))
                st.addLayer(CircleLayer("camion", "camion").withProperties(
                    PropertyFactory.circleRadius(10f), PropertyFactory.circleColor("#1f6feb"),
                    PropertyFactory.circleStrokeColor("#ffffff"), PropertyFactory.circleStrokeWidth(4f)))
                dibujar(true)
            }
        }
        pantalla = vd; presentacion = p; vista = mv
    }

    override fun onVisibleAreaChanged(area: Rect) { visible = area; dibujar(false) }
    override fun onStableAreaChanged(area: Rect) {}
    override fun onSurfaceDestroyed(contenedor: SurfaceContainer) { liberar() }

    fun liberar() {
        vista?.let { runCatching { it.onPause(); it.onStop(); it.onDestroy() } }
        runCatching { presentacion?.dismiss() }
        pantalla?.release()
        vista = null; presentacion = null; pantalla = null; mapa = null; estilo = null
    }

    /** Muestra un camino. encuadrar = ver el camino entero (vista previa); si no, sigue al camión. */
    fun mostrarRuta(coords: List<Geo>?, encuadrar: Boolean) {
        ruta = coords; this.encuadrar = encuadrar; siguiendo = !encuadrar
        dibujar(true)
    }

    fun mover(p: Geo, rumbo: Double, seguir: Boolean) {
        pos = p; this.rumbo = rumbo
        if (seguir) { siguiendo = true; encuadrar = false }
        dibujar(false)
    }

    private fun relleno(): DoubleArray {
        val v = visible ?: return doubleArrayOf(0.0, 0.0, 0.0, 0.0)
        return doubleArrayOf(v.left.toDouble(), v.top.toDouble(), (ancho - v.right).toDouble().coerceAtLeast(0.0), (alto - v.bottom).toDouble().coerceAtLeast(0.0))
    }

    private fun dibujar(todo: Boolean) {
        val m = mapa ?: return
        val st = estilo ?: return
        if (todo) {
            val r = ruta
            st.getSourceAs<GeoJsonSource>("ruta")?.setGeoJson(
                if (r != null && r.size > 1) Feature.fromGeometry(LineString.fromLngLats(r.map { Point.fromLngLat(it.lon, it.lat) }))
                else Feature.fromGeometry(LineString.fromLngLats(listOf<Point>())))
        }
        pos?.let { st.getSourceAs<GeoJsonSource>("camion")?.setGeoJson(Feature.fromGeometry(Point.fromLngLat(it.lon, it.lat))) }
        val pad = relleno()
        val r = ruta
        val p = pos
        if (siguiendo && p != null) {
            // Siguiendo al camión: inclinado, mirando hacia adelante, con el camión en el tercio de abajo
            val cam = CameraPosition.Builder().target(LatLng(p.lat, p.lon)).zoom(16.5).bearing(rumbo).tilt(50.0)
                .padding(pad[0], pad[1] + (alto - pad[1] - pad[3]) * 0.35, pad[2], pad[3]).build()
            m.animateCamera(CameraUpdateFactory.newCameraPosition(cam), 900)
        } else if (encuadrar && r != null && r.size > 1 && todo) {
            val b = LatLngBounds.Builder()
            val paso = (r.size / 200).coerceAtLeast(1)
            r.forEachIndexed { i, g -> if (i % paso == 0 || i == r.size - 1) b.include(LatLng(g.lat, g.lon)) }
            m.easeCamera(CameraUpdateFactory.newLatLngBounds(b.build(), pad[0].toInt() + 60, pad[1].toInt() + 60, pad[2].toInt() + 60, pad[3].toInt() + 60), 700)
        } else if (p != null && todo) {
            m.moveCamera(CameraUpdateFactory.newCameraPosition(CameraPosition.Builder().target(LatLng(p.lat, p.lon)).zoom(12.0).build()))
        }
    }
}
