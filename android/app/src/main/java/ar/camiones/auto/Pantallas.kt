package ar.camiones.auto

import android.text.SpannableString
import android.text.Spanned
import androidx.car.app.CarContext
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.Distance
import androidx.car.app.model.DistanceSpan
import androidx.car.app.model.DurationSpan
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SearchTemplate
import androidx.car.app.model.SectionedItemList
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.RoutePreviewNavigationTemplate
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.text.NumberFormat
import java.util.Locale
import kotlin.math.roundToInt

fun distancia(m: Double): Distance =
    if (m >= 1000) Distance.create(if (m >= 10000) (m / 1000).roundToInt().toDouble() else (m / 100).roundToInt() / 10.0, Distance.UNIT_KILOMETERS)
    else Distance.create(((m / 10).roundToInt() * 10).toDouble().coerceAtLeast(0.0), Distance.UNIT_METERS)

fun pesos(v: Double): String = "$" + NumberFormat.getIntegerInstance(Locale.forLanguageTag("es-AR")).format(v.roundToInt())

/** Pantalla de inicio en el auto: viajes asignados y lugares de la empresa. */
class InicioScreen(ctx: CarContext, private val app: Sesion) : Screen(ctx) {
    private var viajes: List<Destino>? = null
    private var lugares: List<Destino>? = null
    private var error: String? = null

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { app.prenderGps(); cargar() }
        })
    }

    private fun cargar() {
        if (!Nube.conectado) { invalidate(); return }
        lifecycleScope.launch {
            try {
                app.camion = Nube.camion()
                viajes = Nube.viajes()
                lugares = Nube.lugares()
                error = null
            } catch (e: Exception) { error = e.message ?: "No se pudieron cargar los datos." }
            invalidate()
        }
    }

    override fun onGetTemplate(): Template {
        if (!Nube.conectado) {
            return MessageTemplate.Builder("Abrí Camiones AR en el celular y entrá con tu usuario y PIN.")
                .setTitle("Camiones AR")
                .addAction(Action.Builder().setTitle("Listo").setOnClickListener { cargar() }.build())
                .build()
        }
        if (!app.tienePermiso()) {
            return MessageTemplate.Builder("Falta el permiso de ubicación. Abrí Camiones AR en el celular y aceptalo.")
                .setTitle("Camiones AR")
                .addAction(Action.Builder().setTitle("Listo").setOnClickListener { app.prenderGps(); invalidate() }.build())
                .build()
        }
        error?.let { e ->
            return MessageTemplate.Builder(e).setTitle("Camiones AR")
                .addAction(Action.Builder().setTitle("Reintentar").setOnClickListener { error = null; invalidate(); cargar() }.build())
                .build()
        }
        val b = ListTemplate.Builder()
            .setTitle("Camiones AR" + (app.camion?.let { " · ${it.nombre}" } ?: ""))
            .setHeaderAction(Action.APP_ICON)
            .setActionStrip(ActionStrip.Builder().addAction(
                Action.Builder().setTitle("Buscar").setOnClickListener { screenManager.push(BuscarScreen(carContext, app)) }.build()).build())
        val v = viajes
        val l = lugares
        if (v == null || l == null) return b.setLoading(true).build()
        fun fila(d: Destino) = Row.Builder().setTitle(d.nombre).apply { if (d.detalle.isNotEmpty()) addText(d.detalle) }
            .setOnClickListener { screenManager.push(VistaPreviaScreen(carContext, app, d)) }.build()
        if (v.isEmpty() && l.isEmpty()) {
            return b.setSingleList(ItemList.Builder().setNoItemsMessage("No tenés viajes asignados. Tocá Buscar para elegir un destino.").build()).build()
        }
        if (v.isNotEmpty()) b.addSectionedList(SectionedItemList.create(ItemList.Builder().apply { v.take(6).forEach { addItem(fila(it)) } }.build(), "Tus viajes"))
        if (l.isNotEmpty()) b.addSectionedList(SectionedItemList.create(ItemList.Builder().apply { l.take(12).forEach { addItem(fila(it)) } }.build(), "Lugares de la empresa"))
        return b.build()
    }
}

/** Buscar una dirección o un lugar (el buscador de la app web). */
class BuscarScreen(ctx: CarContext, private val app: Sesion) : Screen(ctx) {
    private var resultados: List<Destino> = emptyList()
    private var buscando = false
    private var tarea: Job? = null

    override fun onGetTemplate(): Template {
        val lista = ItemList.Builder().setNoItemsMessage(if (buscando) "Buscando…" else "Escribí una dirección, una ciudad o un lugar")
        resultados.forEach { d ->
            lista.addItem(Row.Builder().setTitle(d.nombre).apply { if (d.detalle.isNotEmpty() && d.detalle != d.nombre) addText(d.detalle) }
                .setOnClickListener { screenManager.push(VistaPreviaScreen(carContext, app, d)) }.build())
        }
        return SearchTemplate.Builder(object : SearchTemplate.SearchCallback {
            override fun onSearchTextChanged(texto: String) { buscar(texto, false) }
            override fun onSearchSubmitted(texto: String) { buscar(texto, true) }
        }).setHeaderAction(Action.BACK).setSearchHint("Dirección o lugar").setShowKeyboardByDefault(true)
            .setItemList(lista.build()).build()
    }

    private fun buscar(texto: String, ya: Boolean) {
        tarea?.cancel()
        if (texto.trim().length < 3) return
        tarea = lifecycleScope.launch {
            if (!ya) delay(700)
            buscando = true; invalidate()
            resultados = try { Nube.buscar(texto.trim(), app.ubicacion()) } catch (_: Exception) { emptyList() }
            buscando = false; invalidate()
        }
    }
}

/** Vista previa del camino: duración, distancia, peajes y alertas. Botón Ir. */
class VistaPreviaScreen(ctx: CarContext, private val app: Sesion, private val destino: Destino) : Screen(ctx) {
    private var ruta: Ruta? = null
    private var error: String? = null

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onCreate(owner: LifecycleOwner) { calcular() }
        })
    }

    private fun calcular() {
        lifecycleScope.launch {
            val desde = app.ubicacion()
            if (desde == null) {
                error = "Todavía no tengo tu ubicación. Revisá que el GPS del celular esté prendido."
                invalidate(); return@launch
            }
            try {
                val r = Nube.ruta(desde, destino.geo, app.camion ?: Camion.PorDefecto)
                ruta = r; error = null
                app.mapa.mostrarRuta(r.coords, encuadrar = true)
            } catch (e: Exception) { error = e.message ?: "No se pudo calcular el camino." }
            invalidate()
        }
    }

    private fun resumen(r: Ruta): String {
        val partes = mutableListOf<String>()
        val peajes = r.puntos.filter { it.clase == "peaje" }
        if (peajes.isNotEmpty()) {
            val ejes = app.camion?.ejes
            val total = peajes.mapNotNull { it.tarifa(ejes) }.sum()
            partes += (if (peajes.size == 1) "1 peaje" else "${peajes.size} peajes") + (if (total > 0) " ≈ ${pesos(total)}" else "")
        }
        val controles = r.puntos.count { it.clase == "control" }
        if (controles > 0) partes += if (controles == 1) "1 control" else "$controles controles"
        if (r.clima.isNotEmpty()) partes += "⚠ " + r.clima.joinToString(", ") { "alerta ${it.nivel} por ${it.evento.lowercase()}" }
        return partes.joinToString(" · ").ifEmpty { "Camino para camión" }
    }

    override fun onGetTemplate(): Template {
        error?.let { e ->
            return MessageTemplate.Builder(e).setTitle(destino.nombre).setHeaderAction(Action.BACK)
                .addAction(Action.Builder().setTitle("Reintentar").setOnClickListener { error = null; invalidate(); calcular() }.build())
                .build()
        }
        val b = RoutePreviewNavigationTemplate.Builder().setTitle(destino.nombre).setHeaderAction(Action.BACK)
        val r = ruta ?: return b.setLoading(true).build()
        val titulo = SpannableString("  ·  ").apply {
            setSpan(DurationSpan.create(r.duracion.toLong()), 0, 1, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
            setSpan(DistanceSpan.create(distancia(r.distancia)), 4, 5, Spanned.SPAN_INCLUSIVE_INCLUSIVE)
        }
        val fila = Row.Builder().setTitle(titulo).addText(resumen(r)).build()
        b.setItemList(ItemList.Builder().addItem(fila).setSelectedIndex(0).setOnSelectedListener { }.build())
        b.setNavigateAction(Action.Builder().setTitle("Ir").setOnClickListener {
            screenManager.push(NavScreen(carContext, app, r, destino))
        }.build())
        return b.build()
    }
}
