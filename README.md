# Camiones AR

App web para camiones en Argentina: muestra las restricciones de tránsito pesado (alturas, pesos, largos, calles prohibidas y cargas peligrosas), arma rutas que las esquivan según las medidas de cada camión y guía con GPS y voz.

## Cómo se usa (chofer)

1. Abrí la app desde el celular. En Android, menú ☰ → **Instalar en el celular**; en iPhone, Compartir → Agregar a inicio.
2. Entrá con el **usuario y PIN** que te dio el dueño. Se hace una sola vez: el celular queda conectado.
3. Arriba aparecen **Tus viajes**: tocá uno y después **IR**. También podés escribir **¿A dónde vas?**, elegir un lugar de la empresa o tocar el mapa.
4. Manejando: si la ruta manda por una calle que no se puede, tocá **No puedo pasar**: la app la evita, recalcula y la calle queda marcada para **todos los choferes**. Si el camión pasa la velocidad máxima, suena una alarma, avisa por voz y le llega una alerta al dueño.
5. Al llegar, el viaje queda como terminado solo.

Sin la nube configurada (ver abajo), la app funciona como antes: todo queda guardado en el celular y la clave de rutas se pega en el menú ☰.

## Panel del dueño (`panel.html`)

- **En vivo**: dónde está cada camión, a qué velocidad y hacia dónde va. En rojo los que pasan la velocidad máxima; en gris los que hace más de 10 minutos que no mandan datos. Alertas de velocidad con sonido.
- **Viajes**: asignar chofer, camión, origen, destino, fecha y notas. Al chofer le aparece al instante.
- **Choferes**: alta con usuario y PIN (con botón para mandarlo por WhatsApp), cambiar PIN, desconectar de todos los celulares, borrar.
- **Camiones**: alto, peso, largo, ancho, peso por eje y carga peligrosa. Las rutas se arman con estas medidas.
- **Lugares**: base (Delta Point), clientes y depósitos, buscando la dirección o tocando el mapa.
- **Calles**: las marcadas como "No puedo pasar", quién y cuándo; se pueden sacar o marcar nuevas.
- **Ajustes**: velocidad máxima de la empresa.

La ubicación se manda mientras la app está abierta en el celular del chofer (los navegadores no permiten mandarla con la pantalla apagada o la app cerrada).

## Poner en marcha la nube (Supabase, una sola vez)

1. **Base de datos**: Supabase → SQL Editor → pegá `supabase/migrations/20261103000000_flota.sql` → Run.
2. **Cerrar registros sueltos**: Authentication → Sign In / Providers → Email → desactivá **Allow new users to sign up**. Las cuentas las crea solo el panel.
3. **Tu cuenta de dueño**: Authentication → Users → Add user (tu email y una contraseña, con *Auto Confirm User*). Después, en SQL Editor:
   ```sql
   insert into public.perfiles (id, nombre, rol)
   select id, 'Dueño', 'dueno' from auth.users where email = 'TU_EMAIL'
   on conflict (id) do update set rol = 'dueno';
   ```
4. **Funciones del servidor**: Edge Functions → Deploy a new function → `rutas` (pegá `supabase/functions/rutas/index.ts`) y `choferes` (pegá `supabase/functions/choferes/index.ts`). Con la terminal: `supabase functions deploy rutas` y `supabase functions deploy choferes`.
5. **Clave de rutas en el servidor**: Edge Functions → Secrets → agregá `ORS_KEY` con la clave de openrouteservice/HeiGIT.
6. **Conectar la app**: completá `nube-config.js` con la *Project URL* y la clave *anon/publishable* (Project Settings → API). Son públicas: lo que cada uno puede ver lo deciden las reglas de la base.
7. Cuando ande, sacá la clave de `config.js` (dejá `orsKey: ''`) y **pedí una clave nueva en HeiGIT**: la vieja estuvo publicada en el repositorio.

## Servicio de rutas: api.heigit.org

HeiGIT reemplazó `api.openrouteservice.org` por `api.heigit.org`. La app y la función `rutas` ya usan las direcciones nuevas:

| Antes | Ahora |
|---|---|
| `/v2/directions/driving-hgv/geojson` | `/openrouteservice/v2/directions/driving-hgv/geojson` |
| `/geocode/search` | `/pelias/v1/search` |
| `/geocode/reverse` | `/pelias/v1/reverse` |

Sin nube, si `api.heigit.org` no responde desde el navegador, la app prueba la dirección vieja.

## De dónde salen los datos

- `data/restricciones.json`: restricciones para camiones de OpenStreetMap (hgv, maxheight, maxweight, maxlength, maxaxleload, hazmat), agrupadas por calle. Base consultada en 2026.
- `data/propias.json`: filas de la planilla "Camiones AR - Restricciones de tránsito pesado" (pestaña Restricciones).
- Mapa de calles: [OpenFreeMap](https://openfreemap.org) (estilo Liberty, datos de OpenStreetMap); si no carga, usa las teselas de OpenStreetMap.
- Rutas y búsqueda de direcciones: [openrouteservice](https://openrouteservice.org) de HeiGIT (`api.heigit.org`), perfil para camiones (`driving-hgv`).
- Cuentas, viajes, ubicación en vivo y calles marcadas: [Supabase](https://supabase.com) (`supabase-js` copiado en `vendor/supabase`, licencia MIT).

Datos de mapa y restricciones © [colaboradores de OpenStreetMap](https://www.openstreetmap.org/copyright), licencia ODbL. La app debe mostrar siempre esa atribución.

## Aviso

Es un prototipo. Los datos pueden tener errores o faltantes: el chofer siempre tiene que respetar la señalización en el lugar.

## Límites del servicio gratuito de rutas

- Unas 2.000 rutas y 1.000 búsquedas de direcciones por día.
- Esquivar calles marcadas solo funciona en tramos de hasta 150 km: en viajes largos la app esquiva en una ventana de 25 km alrededor de cada punto marcado y une ese tramo con la ruta normal.
