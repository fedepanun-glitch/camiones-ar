package ar.camiones.auto

import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.model.Action
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.Template
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/**
 * Marcar algo en el camino desde el auto (lo ven los demás choferes y el panel), como el botón ⚠️ de la app web.
 * alMarcar(tipo) se llama después de marcar, para recalcular si es un corte o un puente bajo.
 */
class ReportarScreen(ctx: CarContext, private val app: Sesion, private val alMarcar: (String) -> Unit) : Screen(ctx) {
    private var altura = false

    private val tipos = listOf(
        "corte" to "⛔ Corte", "control" to "👮 Control", "balanza" to "⚖️ Balanza", "altura" to "🌉 Puente bajo",
        "inseguro" to "🚨 Zona insegura", "camino_roto" to "🚧 Camino roto", "bache" to "🕳️ Bache", "angosta" to "↔️ Calle angosta",
    )
    private val alturas = listOf(3.6, 3.8, 4.0, 4.2, 4.4, 4.6)

    override fun onGetTemplate(): Template {
        val lista = ItemList.Builder()
        if (altura) {
            alturas.forEach { h ->
                lista.addItem(Row.Builder().setTitle("${h.toString().replace('.', ',')} m").setOnClickListener { marcar("altura", h) }.build())
            }
            lista.addItem(Row.Builder().setTitle("No sé la altura").setOnClickListener { marcar("altura", null) }.build())
            return ListTemplate.Builder().setTitle("¿Qué altura tiene?").setHeaderAction(Action.BACK).setSingleList(lista.build()).build()
        }
        tipos.forEach { (tipo, nombre) ->
            lista.addItem(Row.Builder().setTitle(nombre).setOnClickListener {
                if (tipo == "altura") { altura = true; invalidate() } else marcar(tipo, null)
            }.build())
        }
        return ListTemplate.Builder().setTitle("¿Qué hay en el camino?").setHeaderAction(Action.BACK).setSingleList(lista.build()).build()
    }

    private fun marcar(tipo: String, dato: Double?) {
        val p = app.ubicacion()
        if (p == null) { CarToast.makeText(carContext, "Todavía no tengo tu ubicación.", CarToast.LENGTH_LONG).show(); return }
        lifecycleScope.launch {
            val texto = try {
                val t = Nube.reportar(tipo, p, dato, app.obstaculos)
                // Se suma a la lista local para esquivarlo enseguida y no volver a avisarlo
                val c = app.camion ?: Camion.PorDefecto
                if (tipo == "corte" || (tipo == "altura" && (dato == null || c.alto >= dato - 0.1))) {
                    app.obstaculos = app.obstaculos + Obstaculo("nuevo" + System.currentTimeMillis(), p, "Marcado por vos", "", true, tipo)
                }
                t
            } catch (e: Exception) { e.message ?: "No se pudo marcar." }
            CarToast.makeText(carContext, texto, CarToast.LENGTH_LONG).show()
            app.voz.decir(texto)
            screenManager.pop()
            alMarcar(tipo)
        }
    }
}
