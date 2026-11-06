-- Camiones AR — barrios populares del registro oficial RENABAP, para avisar "precaución, no te detengas"
-- cuando la ruta pasa a menos de 150 m. No se esquivan ni se marcan como peligrosos: es un aviso de precaución.
create table if not exists public.barrios_populares (
  renabap_id   int primary key,
  nombre       text,
  provincia    text,
  departamento text,
  localidad    text,
  geom         extensions.geometry(MultiPolygon, 4326) not null,
  fuente       text not null default 'RENABAP (Registro Nacional de Barrios Populares)'
);
create index if not exists barrios_populares_geom on public.barrios_populares using gist (geom);
alter table public.barrios_populares enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'barrios_populares' and policyname = 'ver barrios populares') then
    create policy "ver barrios populares" on public.barrios_populares for select to authenticated using (public.es_miembro());
  end if;
end $$;
create or replace function public.barrios_en_ruta(linea jsonb) returns table (renabap_id int, nombre text, localidad text, lat double precision, lon double precision)
language sql stable security definer set search_path = public, extensions as $$
  with l as (select st_setsrid(st_geomfromgeojson(linea::text), 4326) g)
  select b.renabap_id, b.nombre, b.localidad, st_y(p), st_x(p)
  from l, barrios_populares b, lateral (select st_closestpoint(l.g, b.geom) p) cp
  where st_dwithin(b.geom::geography, l.g::geography, 150) and b.geom && st_expand(l.g, 0.01)
  order by st_linelocatepoint(l.g, p)
  limit 200
$$;
revoke execute on function public.barrios_en_ruta(jsonb) from public, anon;
grant execute on function public.barrios_en_ruta(jsonb) to authenticated, service_role;
