-- Camiones AR — panel de flota.
-- Una empresa por proyecto de Supabase: el dueño ve y carga todo; cada chofer ve lo suyo.
-- Se puede pegar entero en Supabase → SQL Editor → Run. Se puede correr más de una vez.

-- ---------- Personas ----------
create table if not exists public.perfiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  nombre     text not null,
  usuario    text unique,                 -- para entrar: usuario + PIN (los choferes)
  rol        text not null default 'chofer' check (rol in ('dueno', 'chofer')),
  camion_id  uuid,                        -- camión que maneja habitualmente
  telefono   text,
  creado     timestamptz not null default now()
);

-- ¿El que pide es el dueño? (security definer para que las reglas no se llamen a sí mismas)
create or replace function public.es_dueno() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol = 'dueno');
$$;

-- ¿El que pide es de la empresa (dueño o chofer dado de alta)? Una cuenta suelta no ve nada.
create or replace function public.es_miembro() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid());
$$;

-- ---------- Camiones ----------
create table if not exists public.camiones (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,               -- nombre o patente
  alto       numeric(4,2) not null default 4.10 check (alto between 1 and 6),
  peso       numeric(5,2) not null default 45   check (peso between 1 and 100),
  largo      numeric(5,2) not null default 20   check (largo between 2 and 40),
  ancho      numeric(4,2) not null default 2.60 check (ancho between 1 and 4),
  eje        numeric(4,2) not null default 10.5 check (eje between 1 and 30),
  peligrosa  boolean not null default false,
  activo     boolean not null default true,
  creado     timestamptz not null default now()
);
do $$ begin
  alter table public.perfiles add constraint perfiles_camion_fk foreign key (camion_id) references public.camiones(id) on delete set null;
exception when duplicate_object then null; end $$;

-- ---------- Lugares de la empresa ----------
create table if not exists public.lugares (
  id         uuid primary key default gen_random_uuid(),
  nombre     text not null,
  tipo       text not null default 'cliente' check (tipo in ('base', 'cliente', 'deposito', 'otro')),
  direccion  text,
  lat        double precision not null check (lat between -56 and -21),
  lon        double precision not null check (lon between -74 and -53),
  notas      text,                        -- horario, portón, contacto…
  creado     timestamptz not null default now()
);

-- ---------- Viajes asignados ----------
create table if not exists public.viajes (
  id          uuid primary key default gen_random_uuid(),
  chofer_id   uuid references public.perfiles(id) on delete set null,
  camion_id   uuid references public.camiones(id) on delete set null,
  origen_id   uuid references public.lugares(id) on delete set null,
  destino_id  uuid not null references public.lugares(id) on delete restrict,
  fecha       date not null default current_date,
  notas       text,
  estado      text not null default 'pendiente' check (estado in ('pendiente', 'en_curso', 'terminado', 'cancelado')),
  empezado    timestamptz,
  terminado   timestamptz,
  creado      timestamptz not null default now()
);
create index if not exists viajes_chofer_idx on public.viajes (chofer_id, fecha);

-- El chofer solo puede mover el estado de SUS viajes (no cambiar destino, camión, etc.)
create or replace function public.cambiar_estado_viaje(p_viaje uuid, p_estado text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_estado not in ('en_curso', 'terminado') then raise exception 'estado no permitido'; end if;
  update public.viajes set
    estado    = p_estado,
    empezado  = case when p_estado = 'en_curso' then coalesce(empezado, now()) else empezado end,
    terminado = case when p_estado = 'terminado' then now() else terminado end
  where id = p_viaje and (chofer_id = auth.uid() or public.es_dueno()) and estado <> 'cancelado';
  if not found then raise exception 'viaje no encontrado'; end if;
end $$;

-- ---------- Ubicación en vivo (una fila por chofer, se pisa) ----------
create table if not exists public.posiciones (
  chofer_id  uuid primary key references public.perfiles(id) on delete cascade,
  camion_id  uuid references public.camiones(id) on delete set null,
  viaje_id   uuid references public.viajes(id) on delete set null,
  lat        double precision not null,
  lon        double precision not null,
  velocidad  real,                        -- km/h
  rumbo      real,
  precision_m real,
  at         timestamptz not null default now()
);

-- ---------- Alertas (exceso de velocidad) ----------
create table if not exists public.alertas (
  id         bigint generated always as identity primary key,
  chofer_id  uuid not null default auth.uid() references public.perfiles(id) on delete cascade,
  camion_id  uuid references public.camiones(id) on delete set null,
  viaje_id   uuid references public.viajes(id) on delete set null,
  tipo       text not null default 'velocidad' check (tipo in ('velocidad')),
  velocidad  real not null,
  limite     real not null,
  lat        double precision,
  lon        double precision,
  vista      boolean not null default false,
  at         timestamptz not null default now()
);
create index if not exists alertas_at_idx on public.alertas (at desc);

-- ---------- "No puedo pasar": calles marcadas, compartidas por todos ----------
create table if not exists public.bloqueos (
  id         uuid primary key default gen_random_uuid(),
  lat        double precision not null,
  lon        double precision not null,
  calle      text,
  nota       text,
  creado_por uuid default auth.uid() references public.perfiles(id) on delete set null,
  creado     timestamptz not null default now(),
  activo     boolean not null default true
);

-- ---------- Ajustes de la empresa (una sola fila) ----------
create table if not exists public.ajustes (
  id             int primary key default 1 check (id = 1),
  velocidad_max  int not null default 80 check (velocidad_max between 40 and 130)
);
insert into public.ajustes (id) values (1) on conflict do nothing;

-- ---------- Reglas de acceso ----------
alter table public.perfiles   enable row level security;
alter table public.camiones   enable row level security;
alter table public.lugares    enable row level security;
alter table public.viajes     enable row level security;
alter table public.posiciones enable row level security;
alter table public.alertas    enable row level security;
alter table public.bloqueos   enable row level security;
alter table public.ajustes    enable row level security;

do $$ declare p record; begin
  for p in select policyname, tablename from pg_policies where schemaname = 'public'
    and tablename in ('perfiles','camiones','lugares','viajes','posiciones','alertas','bloqueos','ajustes')
  loop execute format('drop policy %I on public.%I', p.policyname, p.tablename); end loop;
end $$;

-- perfiles: cada uno ve el suyo; el dueño ve todos. Altas y bajas de choferes: función "choferes" (servidor).
create policy "ver perfil" on public.perfiles for select to authenticated using (id = auth.uid() or public.es_dueno());
create policy "dueño edita perfiles" on public.perfiles for update to authenticated using (public.es_dueno()) with check (public.es_dueno());

-- camiones, lugares, ajustes: todos los ven; solo el dueño los cambia
create policy "ver camiones" on public.camiones for select to authenticated using (public.es_miembro());
create policy "dueño camiones" on public.camiones for all to authenticated using (public.es_dueno()) with check (public.es_dueno());
create policy "ver lugares" on public.lugares for select to authenticated using (public.es_miembro());
create policy "dueño lugares" on public.lugares for all to authenticated using (public.es_dueno()) with check (public.es_dueno());
create policy "ver ajustes" on public.ajustes for select to authenticated using (public.es_miembro());
create policy "dueño ajustes" on public.ajustes for update to authenticated using (public.es_dueno()) with check (public.es_dueno());

-- viajes: el chofer ve los suyos; el dueño los arma
create policy "ver viajes" on public.viajes for select to authenticated using (chofer_id = auth.uid() or public.es_dueno());
create policy "dueño viajes" on public.viajes for all to authenticated using (public.es_dueno()) with check (public.es_dueno());

-- posiciones: cada chofer escribe la suya; el dueño ve todas
create policy "ver posiciones" on public.posiciones for select to authenticated using (chofer_id = auth.uid() or public.es_dueno());
create policy "mandar posición" on public.posiciones for insert to authenticated with check (chofer_id = auth.uid());
create policy "actualizar posición" on public.posiciones for update to authenticated using (chofer_id = auth.uid()) with check (chofer_id = auth.uid());
create policy "dueño borra posiciones" on public.posiciones for delete to authenticated using (public.es_dueno());

-- alertas: el chofer las manda; el dueño las ve y las marca como vistas
create policy "mandar alerta" on public.alertas for insert to authenticated with check (chofer_id = auth.uid());
create policy "ver alertas" on public.alertas for select to authenticated using (chofer_id = auth.uid() or public.es_dueno());
create policy "dueño marca alertas" on public.alertas for update to authenticated using (public.es_dueno()) with check (public.es_dueno());
create policy "dueño borra alertas" on public.alertas for delete to authenticated using (public.es_dueno());

-- bloqueos: todos los ven y todos marcan; los saca el dueño o quien lo marcó
create policy "ver bloqueos" on public.bloqueos for select to authenticated using (public.es_miembro());
create policy "marcar bloqueo" on public.bloqueos for insert to authenticated with check (creado_por = auth.uid());
create policy "sacar bloqueo" on public.bloqueos for update to authenticated using (public.es_dueno() or creado_por = auth.uid()) with check (public.es_dueno() or creado_por = auth.uid());
create policy "borrar bloqueo" on public.bloqueos for delete to authenticated using (public.es_dueno() or creado_por = auth.uid());

-- Desconectar a un chofer de todos sus celulares (la usa solo la función "choferes" del servidor)
create or replace function public.cerrar_sesiones(p_user uuid) returns void
language sql security definer set search_path = public, auth as $$
  delete from auth.sessions where user_id = p_user;
$$;
revoke execute on function public.cerrar_sesiones(uuid) from anon, authenticated, public;
grant execute on function public.cerrar_sesiones(uuid) to service_role;

grant execute on function public.es_dueno() to authenticated;
grant execute on function public.es_miembro() to authenticated;
grant execute on function public.cambiar_estado_viaje(uuid, text) to authenticated;
revoke execute on function public.cambiar_estado_viaje(uuid, text) from anon, public;

-- ---------- En vivo ----------
do $$ declare t text; begin
  foreach t in array array['posiciones','alertas','bloqueos','viajes','lugares','camiones','ajustes'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- ---------- Primer dueño ----------
-- 1) Supabase → Authentication → Users → Add user → Create new user (tu email y una contraseña, "Auto Confirm User" tildado).
-- 2) Correr esto con tu email:
--    insert into public.perfiles (id, nombre, rol)
--    select id, 'Dueño', 'dueno' from auth.users where email = 'TU_EMAIL'
--    on conflict (id) do update set rol = 'dueno';
