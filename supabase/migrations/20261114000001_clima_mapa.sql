-- Camiones AR — alertas del SMN para el mapa del panel: las zonas vigentes o próximas, unidas por evento y horario,
-- simplificadas (~1 km) para que el mapa cargue rápido. Solo agrega cosas.
create or replace function public.clima_mapa()
returns jsonb
language sql stable security definer set search_path = public, extensions as $$
  select case when not public.es_miembro() then null else jsonb_build_object('type', 'FeatureCollection', 'features', coalesce(jsonb_agg(
    jsonb_build_object('type', 'Feature',
      'geometry', st_asgeojson(st_simplifypreservetopology(g, 0.01), 4)::jsonb,
      'properties', jsonb_build_object('evento', evento, 'nivel', nivel, 'desde', desde, 'hasta', hasta, 'descripcion', d))), '[]'::jsonb)) end
  from (
    select evento, nivel, desde, hasta, max(descripcion) d, st_union(area) g
    from alertas_clima
    where hasta is null or hasta > now()
    group by evento, nivel, desde, hasta
  ) x
$$;
revoke execute on function public.clima_mapa() from public, anon;
grant execute on function public.clima_mapa() to authenticated, service_role;
