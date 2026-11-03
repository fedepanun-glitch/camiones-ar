# Camiones AR

App web para camiones en Argentina: muestra las restricciones de tránsito pesado (alturas, pesos, largos, calles prohibidas y cargas peligrosas), arma rutas que las esquivan según las medidas de cada camión y guía con GPS y voz.

## Cómo se usa

1. Abrí la app desde el celular y tocá **Instalar en el celular** (o, en iPhone, Compartir → Agregar a inicio).
2. En **Mi camión** cargá altura, peso cargado, largo, ancho, peso por eje y si lleva carga peligrosa.
3. En la misma pestaña pegá la **clave de rutas** de OpenRouteService (una sola vez por celular).
4. En **Viaje** elegí el destino, tocá **Armar ruta para mi camión** y después **Iniciar navegación**.

## De dónde salen los datos

- `data/restricciones.json`: restricciones para camiones de OpenStreetMap (hgv, maxheight, maxweight, maxlength, maxaxleload, hazmat), agrupadas por calle. Base consultada en 2026.
- `data/propias.json`: filas de la planilla "Camiones AR - Restricciones de tránsito pesado" (pestaña Restricciones).
- Mapa de calles: teselas de OpenStreetMap.
- Rutas y búsqueda de direcciones: [openrouteservice](https://openrouteservice.org), perfil para camiones (`driving-hgv`).

Datos de mapa y restricciones © [colaboradores de OpenStreetMap](https://www.openstreetmap.org/copyright), licencia ODbL. La app debe mostrar siempre esa atribución.

## Aviso

Es un prototipo. Los datos pueden tener errores o faltantes: el chofer siempre tiene que respetar la señalización en el lugar.
