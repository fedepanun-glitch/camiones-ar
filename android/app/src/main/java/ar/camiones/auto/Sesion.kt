package ar.camiones.auto

import android.Manifest
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Looper
import androidx.car.app.AppManager
import androidx.car.app.CarAppService
import androidx.car.app.Screen
import androidx.car.app.ScreenManager
import androidx.car.app.Session
import androidx.car.app.navigation.NavigationManager
import androidx.car.app.navigation.NavigationManagerCallback
import androidx.car.app.validation.HostValidator
import androidx.lifecycle.DefaultLifecycleObserver
import androidx.lifecycle.LifecycleOwner

/** Punto de entrada de Android Auto. */
class CamionesCarAppService : CarAppService() {
    // TODO al publicar en Play Store: validar solo los hosts de Android Auto (R.array.hosts_allowlist_sample)
    override fun createHostValidator(): HostValidator = HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
    @Deprecated("Deprecated in Java")
    override fun onCreateSession(): Session = Sesion()
}

/** Una sesión = el celular conectado al auto. Tiene el mapa, la voz, el GPS y el camión del chofer. */
class Sesion : Session(), LocationListener {
    lateinit var mapa: MapaCarro
    lateinit var voz: Voz
    lateinit var nav: NavigationManager
    var camion: Camion? = null
    /** Puentes con límite, reportes y bloqueos (se cargan al abrir). */
    var obstaculos: List<Obstaculo> = emptyList()
    var feriados: Set<String> = emptySet()
    var ultima: Location? = null
        private set
    /** La pantalla de navegación se suscribe acá para recibir cada posición del GPS. */
    var alMoverse: ((Location) -> Unit)? = null
    private var gpsActivo = false

    override fun onCreateScreen(intent: Intent): Screen {
        Nube.init(carContext)
        mapa = MapaCarro(carContext)
        carContext.getCarService(AppManager::class.java).setSurfaceCallback(mapa)
        voz = Voz(carContext)
        nav = carContext.getCarService(NavigationManager::class.java)
        nav.setNavigationManagerCallback(object : NavigationManagerCallback {
            override fun onStopNavigation() { carContext.getCarService(ScreenManager::class.java).popToRoot() }
            override fun onAutoDriveEnabled() {}
        })
        lifecycle.addObserver(object : DefaultLifecycleObserver {
            override fun onStart(owner: LifecycleOwner) { prenderGps() }
            override fun onDestroy(owner: LifecycleOwner) { apagarGps(); voz.cerrar(); mapa.liberar() }
        })
        return InicioScreen(carContext, this)
    }

    fun tienePermiso() = carContext.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED

    @SuppressLint("MissingPermission")
    fun prenderGps() {
        if (gpsActivo || !tienePermiso()) return
        val lm = carContext.getSystemService(LocationManager::class.java)
        ultima = listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            .mapNotNull { runCatching { lm.getLastKnownLocation(it) }.getOrNull() }.maxByOrNull { it.time }
        runCatching { lm.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000L, 0f, this, Looper.getMainLooper()) }
        runCatching { lm.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 5000L, 0f, this, Looper.getMainLooper()) }
        gpsActivo = true
    }

    private fun apagarGps() {
        if (!gpsActivo) return
        runCatching { carContext.getSystemService(LocationManager::class.java).removeUpdates(this) }
        gpsActivo = false
    }

    override fun onLocationChanged(l: Location) {
        // El GPS manda; la red solo sirve hasta que haya GPS
        val u = ultima
        if (l.provider == LocationManager.NETWORK_PROVIDER && u != null && u.provider == LocationManager.GPS_PROVIDER &&
            l.time - u.time < 15000) return
        ultima = l
        val cb = alMoverse
        if (cb != null) cb(l) else mapa.mover(Geo(l.latitude, l.longitude), if (l.hasBearing()) l.bearing.toDouble() else 0.0, false)
    }

    fun ubicacion(): Geo? = ultima?.let { Geo(it.latitude, it.longitude) }
}
