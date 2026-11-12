package ar.camiones.auto

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.launch

/** Pantalla del celular: entrar con usuario y PIN (los mismos de la app web) y dar permiso de ubicación. */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Nube.init(this)
        mostrar()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun mostrar() {
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(56), dp(24), dp(24))
        }
        col.addView(TextView(this).apply { text = "Camiones AR"; textSize = 28f })
        if (Nube.conectado) {
            col.addView(TextView(this).apply {
                text = "Entraste como ${Nube.nombre ?: "chofer"}.\n\nConectá el celular al auto y abrí Camiones AR en la pantalla de Android Auto. " +
                    "Ahí vas a ver tus viajes, los lugares de la empresa y el buscador."
                textSize = 18f; setPadding(0, dp(16), 0, dp(24))
            })
            col.addView(Button(this).apply {
                text = "Salir"
                setOnClickListener { lifecycleScope.launch { Nube.salir(); mostrar() } }
            })
            pedirPermisos()
        } else {
            val usuario = EditText(this).apply { hint = "Usuario (o email del dueño)"; inputType = InputType.TYPE_CLASS_TEXT; textSize = 18f }
            val clave = EditText(this).apply {
                hint = "PIN (o contraseña)"; textSize = 18f
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            val error = TextView(this).apply { setTextColor(0xFFC8102E.toInt()); textSize = 16f }
            val entrar = Button(this).apply { text = "Entrar"; gravity = Gravity.CENTER }
            entrar.setOnClickListener {
                entrar.isEnabled = false; error.text = ""
                lifecycleScope.launch {
                    try { Nube.entrar(usuario.text.toString(), clave.text.toString()); mostrar() }
                    catch (e: Exception) { error.text = e.message ?: "No se pudo entrar." }
                    finally { entrar.isEnabled = true }
                }
            }
            col.addView(TextView(this).apply { text = "Entrá con el mismo usuario y PIN de la app."; textSize = 16f; setPadding(0, dp(12), 0, dp(12)) })
            col.addView(usuario); col.addView(clave); col.addView(entrar); col.addView(error)
        }
        setContentView(ScrollView(this).apply { addView(col) })
    }

    private fun pedirPermisos() {
        val faltan = listOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
            .filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (faltan.isNotEmpty()) requestPermissions(faltan.toTypedArray(), 1)
    }
}
