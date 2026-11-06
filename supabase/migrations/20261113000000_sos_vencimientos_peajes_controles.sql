-- Camiones AR — botón SOS, vencimientos de papeles, peajes, puestos de control (sanitarios, aduanas, balanzas)
-- y restricciones de circulación de la ANSV (fines de semana largos). Solo agrega cosas.

-- ---------- SOS: el chofer pide ayuda y el panel se entera al instante ----------
create table if not exists public.sos (
  id           bigserial primary key,
  chofer_id    uuid not null default auth.uid() references public.perfiles(id) on delete cascade,
  camion_id    uuid references public.camiones(id) on delete set null,
  lat          double precision,
  lon          double precision,
  motivo       text not null default 'ayuda' check (motivo in ('ayuda', 'robo', 'accidente', 'mecanica', 'salud')),
  at           timestamptz not null default now(),
  atendida     boolean not null default false,
  atendida_por uuid references public.perfiles(id) on delete set null,
  atendida_at  timestamptz
);
create index if not exists sos_abiertas on public.sos (at desc) where not atendida;
alter table public.sos enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sos' and policyname = 'pedir sos') then
    create policy "pedir sos" on public.sos for insert to authenticated with check (public.es_miembro() and chofer_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sos' and policyname = 'ver sos') then
    create policy "ver sos" on public.sos for select to authenticated using (public.es_panel() or chofer_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sos' and policyname = 'atender sos') then
    create policy "atender sos" on public.sos for update to authenticated using (public.es_dueno()) with check (public.es_dueno());
  end if;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.sos;
exception when duplicate_object then null; end $$;

-- ---------- Vencimientos: licencias, RTO/VTV, seguros, RUTA, permisos ----------
create table if not exists public.vencimientos (
  id         uuid primary key default gen_random_uuid(),
  camion_id  uuid references public.camiones(id) on delete cascade,
  chofer_id  uuid references public.perfiles(id) on delete cascade,
  documento  text not null,
  vence      date not null,
  nota       text,
  creado     timestamptz not null default now()
);
alter table public.vencimientos enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'vencimientos' and policyname = 'ver vencimientos') then
    create policy "ver vencimientos" on public.vencimientos for select to authenticated using (public.es_panel() or chofer_id = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'vencimientos' and policyname = 'cargar vencimientos') then
    create policy "cargar vencimientos" on public.vencimientos for all to authenticated using (public.es_dueno()) with check (public.es_dueno());
  end if;
end $$;

-- ---------- Peajes: ubicación y tarifa por categoría (camiones: categorías 3 a 6 según ejes) ----------
create table if not exists public.peajes (
  id         text primary key,
  nombre     text not null,
  ruta       text,
  operador   text,
  lat        double precision not null,
  lon        double precision not null,
  tarifas    jsonb,          -- {"5": 12345, "6": 14000, …} en pesos, por categoría
  fuente     text,
  fuente_url text,
  vigencia   date
);
alter table public.peajes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'peajes' and policyname = 'ver peajes') then
    create policy "ver peajes" on public.peajes for select to authenticated using (public.es_miembro());
  end if;
end $$;

-- ---------- Puestos de control: sanitarios / fitosanitarios (SENASA), aduanas, balanzas, controles policiales ----------
create table if not exists public.puestos_control (
  id         text primary key,
  tipo       text not null check (tipo in ('sanitario', 'aduana', 'balanza', 'policial', 'otro')),
  nombre     text not null,
  ruta       text,
  lat        double precision not null,
  lon        double precision not null,
  nota       text,
  fuente     text,
  fuente_url text
);
alter table public.puestos_control enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'puestos_control' and policyname = 'ver puestos') then
    create policy "ver puestos" on public.puestos_control for select to authenticated using (public.es_miembro());
  end if;
end $$;

-- ---------- Restricciones de circulación de camiones de la ANSV (feriados, recambios turísticos) ----------
create table if not exists public.restricciones_ansv (
  id         serial primary key,
  desde      timestamptz not null,
  hasta      timestamptz not null,
  titulo     text not null,
  detalle    text,
  fuente     text,
  fuente_url text
);
alter table public.restricciones_ansv enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'restricciones_ansv' and policyname = 'ver restricciones ansv') then
    create policy "ver restricciones ansv" on public.restricciones_ansv for select to authenticated using (public.es_miembro());
  end if;
end $$;

-- Restricciones de la ANSV: tramos y franjas horarias
alter table public.restricciones_ansv add column if not exists franjas jsonb;  -- [["06:00","22:00"]] hora de Argentina; vacío = todo el día
alter table public.restricciones_ansv add column if not exists tramos jsonb;   -- [{"ruta":"RN 19","nombre":"Arroyito – Córdoba","puntos":[[lon,lat],…]}]
alter table public.restricciones_ansv add column if not exists excepciones text;

-- Ejes del camión (categoría de peaje) y búsqueda de peajes y puestos de control sobre una ruta
alter table public.camiones add column if not exists ejes int;
create or replace function public.puntos_en_ruta(linea jsonb)
returns table (clase text, id text, tipo text, nombre text, ruta text, lat double precision, lon double precision, tarifas jsonb, nota text, fuente text, metros double precision)
language sql stable security definer set search_path = public, extensions as $$
  with l as (select st_setsrid(st_geomfromgeojson(linea::text), 4326) g),
  len as (select st_length(g::geography) m from l),
  p as (
    select 'peaje'::text clase, pj.id, 'peaje'::text tipo, pj.nombre, pj.ruta, pj.lat, pj.lon, pj.tarifas, null::text nota, pj.fuente, st_setsrid(st_makepoint(pj.lon, pj.lat), 4326) pt, 120 r from peajes pj
    union all
    select 'control', pc.id, pc.tipo, pc.nombre, pc.ruta, pc.lat, pc.lon, null, pc.nota, pc.fuente, st_setsrid(st_makepoint(pc.lon, pc.lat), 4326), 200 from puestos_control pc
  )
  select p.clase, p.id, p.tipo, p.nombre, p.ruta, p.lat, p.lon, p.tarifas, p.nota, p.fuente, st_linelocatepoint(l.g, p.pt) * len.m
  from p, l, len
  where p.pt && st_expand(l.g, 0.01) and st_dwithin(p.pt::geography, l.g::geography, p.r)
  order by 11
  limit 300
$$;
revoke execute on function public.puntos_en_ruta(jsonb) from public, anon;
grant execute on function public.puntos_en_ruta(jsonb) to authenticated, service_role;
