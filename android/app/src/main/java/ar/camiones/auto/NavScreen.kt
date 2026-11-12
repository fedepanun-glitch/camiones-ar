package ar.camiones.auto

import android.location.Location
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ActionStrip
import androidx.car.app.model.CarIcon
import androidx.car.app.model.DateTimeWithZone
import androidx.car.app.model.Template
import androidx.car.app.navigation.model.Maneuver
import androidx.car.app.navigation.model.MessageInfo
import androidx.car.app.navigation.model.NavigationTemplate
import androidx.car.app.navigation.model.RoutingInfo
import androidx.car.app.navigation.model.Step
import androidx.car.app.navigation.model.TravelEstimate
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch
import java.util.TimeZone
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** Navegación giro a giro: sigue la ruta, habla, avisa peajes, controles, alertas del SMN y barrios; recalcula si te desviás. */
class NavScreen(ctx: CarContext, private val app: Sesion, private var ruta: Ruta, private val destino: Destino) : Screen(ctx) {
    private var idx = 0
    private var hecho = 0.0
    private var conPosicion = false
    private var fueraDesde = 0L
    private var ultimoRecalculo = 0L
    private var recalculando = false
    private var terminado = false
    private var ultimoEnvio = 0L
    private val dichos = HashSet<String>()

    init {
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onCreate(owner: LifecycleOwner) {
                app.nav.navigationStarted()
                destino.viajeId?.let { id -> lifecycleScope.launch { Nube.estadoViaje(id, "en_curso") } }
                app.mapa.mostrarRuta(ruta.coords, encuadrar = false)
                app.alMoverse = { l -> moverse(l) }
                app.ultima?.let { moverse(it) }
                app.voz.decir("Vamos a ${destino.nombre}.")
            }
            override fun onDestroy(owner: LifecycleOwner) {
                app.alMoverse = null
                if (!terminado) { terminado = true; app.nav.navigationEnded() }
            }
        })
    }

    /** llego = llegó al destino (el viaje asignado queda terminado, como en la app web). */
    private fun terminar(texto: String?, llego: Boolean = false) {
        if (terminado) return
        terminado = true
        app.nav.navigationEnded()
        if (llego) destino.viajeId?.let { id -> lifecycleScope.launch { Nube.estadoViaje(id, "terminado") } }
        texto?.let { app.voz.decir(it); CarToast.makeText(carContext, it, CarToast.LENGTH_LONG).show() }
        app.mapa.mostrarRuta(null, encuadrar = false)
        screenManager.popToRoot()
    }

    private fun moverse(l: Location) {
        if (terminado) return
        val p = Geo(l.latitude, l.longitude)
        val c = ruta.coords
        if (c.size < 2) return
        // Dónde estoy sobre la ruta: primero cerca del último punto, si no en toda la ruta
        var mejor = Double.MAX_VALUE; var bi = idx; var bt = 0.0
        fun mirar(desde: Int, hasta: Int) {
            for (i in desde until hasta) {
                val (d, t) = G.alSegmento(p, c[i], c[i + 1])
                if (d < mejor) { mejor = d; bi = i; bt = t }
            }
        }
        mirar(max(0, idx - 3), min(c.size - 1, idx + 120))
        if (mejor > 300) mirar(0, c.size - 1)
        idx = bi
        hecho = ruta.cum[bi] + bt * (ruta.cum[bi + 1] - ruta.cum[bi])
        conPosicion = true
        val rumbo = if (l.hasBearing() && l.speed > 2) l.bearing.toDouble() else G.rumbo(c[bi], c[bi + 1])
        app.mapa.mover(p, rumbo, true)

        // ¿Llegó?
        if (ruta.total - hecho < 40 || G.dist(p, destino.geo) < 40) { terminar("Llegaste a ${destino.nombre}.", llego = true); return }

        // ¿Se desvió? (más de 70 m del camino durante 8 segundos, con buen GPS)
        val ahora = System.currentTimeMillis()
        if (mejor > 70 && l.accuracy < 50) { if (fueraDesde == 0L) fueraDesde = ahora } else fueraDesde = 0L
        if (fueraDesde > 0 && ahora - fueraDesde > 8000 && ahora - ultimoRecalculo > 30000 && !recalculando) recalcular(p)

        avisos(p)
        if (ahora - ultimoEnvio > 15000) {
            ultimoEnvio = ahora
            lifecycleScope.launch {
                Nube.posicion(p, l.speed * 3.6, rumbo, l.accuracy.toDouble(), app.camion?.id, destino.nombre)
            }
        }
        invalidate()
    }

    /** El chofer marcó un corte o un puente bajo: se recalcula esquivándolo. */
    private fun esquivarNuevo() {
        val p = app.ubicacion() ?: return
        recalcular(p)
    }

    private fun recalcular(p: Geo) {
        recalculando = true; ultimoRecalculo = System.currentTimeMillis()
        app.voz.decir("Recalculando.")
        invalidate()
        lifecycleScope.launch {
            try {
                ruta = Nube.ruta(p, destino.geo, app.camion ?: Camion.PorDefecto, app.obstaculos)
                idx = 0; hecho = 0.0
                dichos.removeAll { it.startsWith("paso") }
                app.mapa.mostrarRuta(ruta.coords, encuadrar = false)
            } catch (e: Exception) {
                CarToast.makeText(carContext, e.message ?: "No pude recalcular el camino", CarToast.LENGTH_LONG).show()
            }
            recalculando = false; fueraDesde = 0L
            invalidate()
        }
    }

    /** Próxima maniobra (índice en ruta.pasos) y metros hasta ella. */
    private fun proximo(): Pair<Int, Double>? {
        val k = ruta.pasos.indexOfFirst { ruta.metrosDe(it.desde) > hecho + 5 }
        if (k < 0) return null
        return Pair(k, ruta.metrosDe(ruta.pasos[k].desde) - hecho)
    }

    private fun decirUnaVez(clave: String, texto: String, aviso: String? = null) {
        if (!dichos.add(clave)) return
        app.voz.decir(texto)
        aviso?.let { CarToast.makeText(carContext, it, CarToast.LENGTH_LONG).show() }
    }

    private fun metrosTexto(d: Double) = if (d > 700) "1 kilómetro" else "${max(100, (d / 100).roundToInt() * 100)} metros"

    private fun avisos(p: Geo) {
        // Indicaciones habladas antes de cada maniobra
        proximo()?.let { (k, d) ->
            val paso = ruta.pasos[k]
            val ins = paso.instruccion.ifEmpty { "Seguí" }
            when {
                d in 700.0..1100.0 -> decirUnaVez("paso$k-1000", "En 1 kilómetro, $ins.")
                d in 150.0..350.0 -> decirUnaVez("paso$k-300", "En 300 metros, $ins.")
                d < 60 -> decirUnaVez("paso$k-0", "$ins.")
            }
        }
        val ejes = app.camion?.ejes
        // Peajes y puestos de control a 1 km o menos
        for (pt in ruta.puntos) {
            val adelante = pt.metros - hecho
            if (adelante < 0 || adelante > 1100) continue
            val m = metrosTexto(adelante)
            if (pt.clase == "peaje") {
                val pr = Peajes.precio(pt, ruta, ejes, hecho, app.feriados)
                val nombre = if (pt.nombre.isNotEmpty() && pt.nombre != "Peaje") " ${pt.nombre}" else ""
                if (pr.pagadoEn != null) {
                    decirUnaVez("p${pt.id}", "Peaje a $m. Ya lo pagaste en ${pr.pagadoEn}.", "Peaje$nombre a $m: ya pagado en ${pr.pagadoEn}")
                } else {
                    val v = pr.valor
                    decirUnaVez("p${pt.id}", "Peaje a $m." + (v?.let { " Sale ${it.roundToInt()} pesos" + (if (pr.pico) ", hora pico." else ".") } ?: ""),
                        "Peaje$nombre a $m" + (v?.let { ": ${pesos(it)}" + if (pr.pico) " (hora pico)" else "" } ?: ""))
                }
            } else {
                val n = when (pt.tipo) { "sanitario" -> "Control sanitario"; "aduana" -> "Aduana"; "balanza" -> "Balanza"; "policial" -> "Control policial"; else -> "Puesto de control" }
                decirUnaVez("p${pt.id}", "$n a $m. Tené los papeles a mano.", "$n a $m" + if (pt.nombre.isNotEmpty()) ": ${pt.nombre}" else "")
            }
        }
        // Alertas del Servicio Meteorológico Nacional: 10 km antes de entrar a la zona
        for (a in ruta.clima) {
            val adelante = a.entra - hecho
            if (adelante > 10000 || hecho > a.sale) continue
            val ev = a.evento.lowercase()
            val consejo = when {
                ev.contains("viento") || ev.contains("zonda") ->
                    if ((app.camion?.largo ?: 0.0) >= 18) "Con bitrén el viento de costado es peligroso: bajá la velocidad y, si las ráfagas son fuertes, pará en un lugar seguro."
                    else "Bajá la velocidad, cuidado con las ráfagas de costado."
                ev.contains("tormenta") || ev.contains("lluvia") -> "Bajá la velocidad y dejá más distancia de frenado."
                ev.contains("niebla") -> "Luces bajas, mucha distancia y no te detengas sobre la calzada."
                ev.contains("nev") -> "Puede haber cortes por nieve."
                else -> "Manejá con precaución."
            }
            val donde = if (adelante > 500) "en ${max(1, (adelante / 1000).roundToInt())} kilómetros" else "en esta zona"
            decirUnaVez("clima${a.evento}${a.entra}", "Atención. Alerta ${a.nivel} por $ev $donde. $consejo",
                "Alerta ${a.nivel} por $ev: $donde")
        }
        // Puentes con límite, cortes, puentes bajos, zonas inseguras y otros reportes sobre el camino, a 600 m o menos
        for (x in ruta.obstaculos) {
            val adelante = x.metros - hecho
            if (adelante < 0 || adelante > 600) continue
            if (x.o.id.startsWith("of") && !x.o.evitar) continue   // límite oficial que este camión cumple
            val m = "${max(50, (adelante / 50).roundToInt() * 50)} metros"
            decirUnaVez("o${x.o.id}", "${x.o.voz} a $m.", "${x.o.texto} a $m")
        }
        // Barrios populares a menos de 450 m (registro oficial RENABAP)
        for ((i, b) in ruta.precaucion.withIndex()) {
            val d = G.dist(p, b)
            if (d > 450 || d < 20) continue
            decirUnaVez("barrio$i", "Precaución. Barrio popular a ${max(50, (d / 50).roundToInt() * 50)} metros. No te detengas.", "Zona de precaución: no te detengas")
        }
    }

    private fun icono(res: Int) = CarIcon.Builder(IconCompat.createWithResource(carContext, res)).build()

    /** Tipos de instrucción de openrouteservice → maniobras de Android Auto (en Argentina las rotondas giran a la izquierda). */
    private fun maniobra(p: Paso): Maneuver {
        val (tipo, ic) = when (p.tipo) {
            0 -> Maneuver.TYPE_TURN_NORMAL_LEFT to R.drawable.ic_izquierda
            1 -> Maneuver.TYPE_TURN_NORMAL_RIGHT to R.drawable.ic_derecha
            2 -> Maneuver.TYPE_TURN_SHARP_LEFT to R.drawable.ic_izquierda
            3 -> Maneuver.TYPE_TURN_SHARP_RIGHT to R.drawable.ic_derecha
            4 -> Maneuver.TYPE_TURN_SLIGHT_LEFT to R.drawable.ic_leve_izquierda
            5 -> Maneuver.TYPE_TURN_SLIGHT_RIGHT to R.drawable.ic_leve_derecha
            7 -> (if (p.salida > 0) Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW else Maneuver.TYPE_ROUNDABOUT_ENTER_CCW) to R.drawable.ic_rotonda
            8 -> Maneuver.TYPE_ROUNDABOUT_EXIT_CCW to R.drawable.ic_rotonda
            9 -> Maneuver.TYPE_U_TURN_LEFT to R.drawable.ic_vuelta_u
            10 -> Maneuver.TYPE_DESTINATION to R.drawable.ic_destino
            11 -> Maneuver.TYPE_DEPART to R.drawable.ic_recto
            12 -> Maneuver.TYPE_KEEP_LEFT to R.drawable.ic_leve_izquierda
            13 -> Maneuver.TYPE_KEEP_RIGHT to R.drawable.ic_leve_derecha
            else -> Maneuver.TYPE_STRAIGHT to R.drawable.ic_recto
        }
        val b = Maneuver.Builder(tipo).setIcon(icono(ic))
        if (tipo == Maneuver.TYPE_ROUNDABOUT_ENTER_AND_EXIT_CCW) b.setRoundaboutExitNumber(p.salida)
        return b.build()
    }

    private fun paso(p: Paso): Step =
        Step.Builder(p.instruccion.ifEmpty { "Seguí" }).setManeuver(maniobra(p)).apply { if (p.calle.isNotBlank()) setRoad(p.calle) }.build()

    override fun onGetTemplate(): Template {
        val acciones = ActionStrip.Builder()
            .addAction(Action.Builder().setTitle("Reportar").setOnClickListener {
                screenManager.push(ReportarScreen(carContext, app) { tipo -> if (tipo == "corte" || tipo == "altura") esquivarNuevo() })
            }.build())
            .addAction(Action.Builder().setTitle("Terminar").setOnClickListener { terminar(null) }.build())
            .build()
        val b = NavigationTemplate.Builder().setActionStrip(acciones)
        if (!conPosicion || recalculando) {
            return b.setNavigationInfo(RoutingInfo.Builder().setLoading(true).build()).build()
        }
        val prox = proximo()
        if (prox != null) {
            val (k, d) = prox
            val ri = RoutingInfo.Builder().setCurrentStep(paso(ruta.pasos[k]), distancia(d))
            ruta.pasos.getOrNull(k + 1)?.let { ri.setNextStep(paso(it)) }
            b.setNavigationInfo(ri.build())
        } else {
            b.setNavigationInfo(MessageInfo.Builder("Llegando a ${destino.nombre}").setImage(icono(R.drawable.ic_destino)).build())
        }
        val falta = max(0.0, ruta.total - hecho)
        val seg = if (ruta.total > 0) ruta.duracion * falta / ruta.total else 0.0
        val llegada = DateTimeWithZone.create(System.currentTimeMillis() + (seg * 1000).toLong(), TimeZone.getDefault())
        b.setDestinationTravelEstimate(TravelEstimate.Builder(distancia(falta), llegada).setRemainingTimeSeconds(seg.toLong()).build())
        return b.build()
    }
}
