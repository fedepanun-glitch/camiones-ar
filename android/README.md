# Camiones AR para Android Auto

App de Android que muestra Camiones AR en la pantalla del auto (Android Auto). Usa la misma cuenta, los mismos
datos y el mismo cálculo de rutas para camión que la app web.

## Qué hace (versión 0.1)

- **En el celular:** entrar con el usuario y PIN del chofer (o el email del dueño) y dar permiso de ubicación.
- **En el auto:**
  - **Inicio:** tus viajes asignados, los lugares de la empresa y el botón **Buscar**.
  - **Vista previa:** duración, kilómetros, peajes con el precio según los ejes, puestos de control y alertas del SMN, con el botón **Ir**.
  - **Navegación:** indicaciones giro a giro con voz y mapa. Avisa al acercarse a peajes, controles (sanitarios, aduanas, balanzas), zonas con alerta del SMN y barrios populares. Si te desviás, recalcula el camino. Manda la ubicación al panel del dueño cada 15 segundos.

## Cómo conseguir el APK

Cada cambio en `android/` arma el APK en GitHub (Actions → "App Android (Android Auto)").
Se descarga desde la sección **Artifacts** de esa corrida: `camiones-ar-android-auto`.

## Cómo probarla en el auto

Mientras la app no esté publicada en Play Store, Android Auto solo muestra apps de fuentes desconocidas en modo desarrollador:

1. Instalar el APK en el celular. Hay que permitir instalar desde el navegador o desde Archivos.
2. Abrir **Camiones AR** en el celular, entrar con usuario y PIN y aceptar el permiso de ubicación.
3. En el celular: **Ajustes → Apps → Android Auto**, o abrir la app Android Auto. Ir a **Versión** y tocarla 10 veces: se activa el modo desarrollador.
4. En el menú ⋮ → **Configuración para desarrolladores**, activar **Fuentes desconocidas** (Unknown sources).
5. Conectar al auto: Camiones AR aparece entre las apps de navegación.

Sin auto se puede probar en la computadora con el **Desktop Head Unit (DHU)** de Android Studio (SDK Manager → SDK Tools → Android Auto Desktop Head Unit).

## Pendiente para publicarla en Play Store

- Firmar la app con una clave propia (hoy es un APK de prueba).
- Limitar `createHostValidator` a los hosts de Android Auto (hoy acepta todos, solo para pruebas).
- Revisión de Google para apps de navegación en autos.
