-- Camiones AR — rutas pensadas para camiones.
-- red_pesada: calles y avenidas habilitadas para camiones (Red de Tránsito Pesado de CABA y otras), de OpenStreetMap (hgv=designated).
-- zonas: límites de ciudades con red obligatoria (por ahora CABA), para saber cuándo un tramo de la ruta cae adentro.
-- La función "rutas" las usa para elegir, entre varios caminos posibles, el que va por avenidas y por la red.
-- Solo agrega cosas. Se puede correr más de una vez.

create table if not exists public.red_pesada (
  osm_id   bigint primary key,
  nombre   text,
  coords   jsonb not null,            -- [[lon, lat], …]
  fuente   text not null default 'osm',
  creado   timestamptz not null default now()
);
alter table public.red_pesada enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'red_pesada' and policyname = 'ver red pesada') then
    create policy "ver red pesada" on public.red_pesada for select to authenticated using (public.es_miembro());
  end if;
end $$;

create table if not exists public.zonas (
  id      text primary key,           -- 'caba'
  nombre  text not null,
  anillos jsonb not null              -- [[[lon, lat], …], …] (anillos exteriores)
);
alter table public.zonas enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'zonas' and policyname = 'ver zonas') then
    create policy "ver zonas" on public.zonas for select to authenticated using (public.es_miembro());
  end if;
end $$;
