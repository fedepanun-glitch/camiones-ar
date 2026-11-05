-- Camiones AR — carteles de kilómetro (OpenStreetMap) y su ruta, para ubicar en el mapa datos oficiales que vienen como "ruta y km"
-- (por ejemplo, el listado de puentes limitados de Vialidad Nacional). Solo agrega cosas.
create table if not exists public.mojones (
  osm_id bigint primary key,
  km     numeric(8,2) not null,
  lat    double precision not null,
  lon    double precision not null
);
create index if not exists mojones_km on public.mojones (km);
create table if not exists public.mojon_ruta (osm_id bigint not null, ref text not null, primary key (osm_id, ref));
create table if not exists public.rutas_trazado (
  ref     text not null,
  osm_id  bigint not null,
  coords  jsonb not null,
  primary key (ref, osm_id)
);
alter table public.mojones enable row level security;
alter table public.mojon_ruta enable row level security;
alter table public.rutas_trazado enable row level security;
