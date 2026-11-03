-- Camiones AR — fotomultas y administradores.
-- Se puede correr más de una vez.

-- ---------- Administradores ----------
-- Además del dueño, puede haber administradores (administrativos, socios) que usan el panel con email y contraseña.
-- Tienen los mismos permisos que el dueño, salvo crear o borrar otros administradores (eso lo hace solo el dueño).
alter table public.perfiles drop constraint if exists perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check check (rol in ('dueno', 'admin', 'chofer'));
alter table public.perfiles add column if not exists email text;

-- es_dueno() = "puede usar el panel" (dueño o administrador)
create or replace function public.es_dueno() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol in ('dueno', 'admin'));
$$;

-- ---------- Fotomultas ----------
create table if not exists public.radares (
  id         uuid primary key default gen_random_uuid(),
  lat        double precision not null check (lat between -56 and -21),
  lon        double precision not null check (lon between -74 and -53),
  maxima     int check (maxima between 10 and 150),         -- km/h que controla la cámara (si se sabe)
  rumbo      real check (rumbo >= 0 and rumbo < 360),       -- hacia dónde mira (grados); vacío = ambos sentidos
  tipo       text not null default 'fotomulta' check (tipo in ('fotomulta', 'semaforo', 'control')),
  nota       text,
  fuente     text not null default 'manual' check (fuente in ('manual', 'osm')),
  osm_id     text unique,                                   -- n123 / r456 si vino de OpenStreetMap
  creado_por uuid default auth.uid() references public.perfiles(id) on delete set null,
  creado     timestamptz not null default now(),
  activo     boolean not null default true
);
create index if not exists radares_pos_idx on public.radares (lat, lon) where activo;

alter table public.radares enable row level security;
drop policy if exists "ver radares" on public.radares;
create policy "ver radares" on public.radares for select to authenticated using (public.es_miembro());
drop policy if exists "marcar radar" on public.radares;
create policy "marcar radar" on public.radares for insert to authenticated with check (public.es_miembro() and creado_por = auth.uid() and fuente = 'manual');
drop policy if exists "dueño radares" on public.radares;
create policy "dueño radares" on public.radares for update to authenticated using (public.es_dueno()) with check (public.es_dueno());
drop policy if exists "dueño borra radares" on public.radares;
create policy "dueño borra radares" on public.radares for delete to authenticated using (public.es_dueno());

do $$ begin
  alter publication supabase_realtime add table public.radares;
exception when duplicate_object then null; end $$;

-- Email del dueño, para mostrarlo en la lista de administradores
update public.perfiles p set email = u.email from auth.users u where u.id = p.id and p.rol = 'dueno' and p.email is null;
