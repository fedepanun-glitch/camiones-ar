-- Camiones AR — el dueño ve la ruta que va a hacer cada camión.
-- viajes.ruta: la ruta planeada (la calcula el panel al asignar) o la que eligió la app del chofer al tocar IR.
-- posiciones.ruta: la ruta que el chofer está siguiendo ahora (también en viajes sin asignar).
-- Se puede correr más de una vez.

alter table public.viajes add column if not exists ruta jsonb;          -- GeoJSON LineString [lon, lat]
alter table public.viajes add column if not exists ruta_km real;
alter table public.viajes add column if not exists ruta_min real;
alter table public.viajes add column if not exists ruta_origen text;    -- 'panel' (planeada) o 'chofer' (la que sigue)
alter table public.viajes add column if not exists ruta_at timestamptz;

alter table public.posiciones add column if not exists ruta jsonb;
alter table public.posiciones add column if not exists destino text;

-- El chofer guarda la ruta de SU viaje (no puede tocar nada más del viaje)
create or replace function public.guardar_ruta_viaje(p_viaje uuid, p_ruta jsonb, p_km real, p_min real) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_ruta is null or p_ruta->>'type' <> 'LineString' or jsonb_array_length(p_ruta->'coordinates') > 2000 then
    raise exception 'ruta inválida';
  end if;
  update public.viajes set ruta = p_ruta, ruta_km = p_km, ruta_min = p_min, ruta_origen = 'chofer', ruta_at = now()
  where id = p_viaje and (chofer_id = auth.uid() or public.es_dueno()) and estado in ('pendiente', 'en_curso');
  if not found then raise exception 'viaje no encontrado'; end if;
end $$;
revoke execute on function public.guardar_ruta_viaje(uuid, jsonb, real, real) from anon, public;
grant execute on function public.guardar_ruta_viaje(uuid, jsonb, real, real) to authenticated;
