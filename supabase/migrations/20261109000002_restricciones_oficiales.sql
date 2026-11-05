-- Camiones AR — restricciones oficiales (normativa), cada una con su fuente.
-- Ej.: puentes con límite de peso (Vialidad Nacional), curvas que requieren autorización para bitrenes
-- (Res. 1196/2025), Red de Tránsito Pesado de CABA, ordenanzas municipales. Solo agrega cosas.
create table if not exists public.restricciones_oficiales (
  id          uuid primary key default gen_random_uuid(),
  tipo        text not null check (tipo in ('peso', 'peso_eje', 'clausurado', 'altura', 'largo', 'curva_bitren', 'prohibido_camiones', 'horario', 'otro')),
  jurisdiccion text not null default 'nacional',   -- nacional, provincia X, municipio X, CABA
  ruta        text,                                -- 'RN 3', 'A001', 'PEPS'…
  km          numeric(8,2),
  provincia   text,
  nombre      text,
  valor       real,                                -- toneladas, metros… según el tipo
  valor_eje   real,                                -- toneladas por eje
  lat         double precision,
  lon         double precision,
  ubicacion   text,                                -- cómo se ubicó: 'poste km', 'manual', 'osm'…
  nota        text,
  fuente      text not null,                       -- nombre de la norma o documento
  fuente_url  text,
  fuente_fecha date,
  orden       int,                                 -- Nº de orden en el documento
  activo      boolean not null default true,
  creado      timestamptz not null default now()
);
create unique index if not exists restricciones_oficiales_unica on public.restricciones_oficiales (fuente_url, orden);
create index if not exists restricciones_oficiales_pos on public.restricciones_oficiales (lat, lon) where activo;
alter table public.restricciones_oficiales enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'restricciones_oficiales' and policyname = 'ver restricciones oficiales') then
    create policy "ver restricciones oficiales" on public.restricciones_oficiales for select to authenticated using (public.es_miembro());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'restricciones_oficiales' and policyname = 'dueño restricciones oficiales') then
    create policy "dueño restricciones oficiales" on public.restricciones_oficiales for all to authenticated using (public.es_dueno()) with check (public.es_dueno());
  end if;
end $$;
