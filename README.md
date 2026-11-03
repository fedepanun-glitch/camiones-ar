# Camiones AR

App web para camiones en Argentina: muestra las restricciones de tránsito pesado (alturas, pesos, largos, calles prohibidas y cargas peligrosas), arma rutas que las esquivan según las medidas de cada camión y guía con GPS y voz.

## Cómo se usa

1. Abrí la app desde el celular. En Android, menú ☰ → **Instalar en el celular**; en iPhone, Compartir → Agregar a inicio.
2. Menú ☰ → **Camiones**: cargá cada camión con alto, peso, largo, ancho, peso por eje y si lleva carga peligrosa.
3. Menú ☰ → **Clave de rutas**: pegá la clave de OpenRouteService (una sola vez por celular), o dejala en `config.js` (ver `config.example.js`).
4. Escribí **¿A dónde vas?** (o tocá el mapa), revisá la ruta y tocá **IR**.
5. Manejando: si la ruta manda por una calle que no se puede, tocá **No puedo pasar**: la app la evita y recalcula. Si el camión pasa los 80 km/h (se cambia en Ajustes), suena una alarma y avisa por voz.

## De dónde salen los datos

- `data/restricciones.json`: restricciones para camiones de OpenStreetMap (hgv, maxheight, maxweight, maxlength, maxaxleload, hazmat), agrupadas por calle. Base consultada en 2026.
- `data/propias.json`: filas de la planilla "Camiones AR - Restricciones de tránsito pesado" (pestaña Restricciones).
- Mapa de calles: [OpenFreeMap](https://openfreemap.org) (estilo Liberty, datos de OpenStreetMap); si no carga, usa las teselas de OpenStreetMap.
- Rutas y búsqueda de direcciones: [openrouteservice](https://openrouteservice.org), perfil para camiones (`driving-hgv`).

Datos de mapa y restricciones © [colaboradores de OpenStreetMap](https://www.openstreetmap.org/copyright), licencia ODbL. La app debe mostrar siempre esa atribución.

## Aviso

Es un prototipo. Los datos pueden tener errores o faltantes: el chofer siempre tiene que respetar la señalización en el lugar.

## Límites del servicio gratuito de rutas

- Unas 2.000 rutas y 1.000 búsquedas de direcciones por día.
- Esquivar calles marcadas solo funciona en tramos de hasta 150 km: en viajes largos la app esquiva en una ventana de 25 km alrededor de cada punto marcado y une ese tramo con la ruta normal.
