-- Camiones AR — rastreador satelital Sitrack.
-- La función "sitrack" consulta cada minuto la última posición de todas las unidades de la cuenta
-- (GET https://externalappgw.ar.sitrack.com/v2/report) y la guarda acá, asociada al camión por la patente.
-- Se puede correr más de una vez.

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

-- Patente del camión tal como figura en Sitrack (si no se carga, se compara con el nombre)
alter table public.camiones add column if not exists patente text;

-- Última posición de cada unidad según Sitrack (una fila por patente, se pisa)
create table if not exists public.rastreo (
  asset_id    text primary key,           -- patente según Sitrack
  camion_id   uuid references public.camiones(id) on delete set null,
  nombre      text,                       -- nombre interno de la unidad en Sitrack
  lat         double precision,
  lon         double precision,
  velocidad   real,                       -- km/h
  rumbo       real,
  direccion   text,                       -- dirección aproximada que da Sitrack
  encendido   boolean,
  evento      text,
  reporte_at  timestamptz,                -- hora del reporte del equipo
  actualizado timestamptz not null default now()
);

-- Estado de la conexión con Sitrack (una sola fila), para mostrar en el panel
create table if not exists public.sitrack_estado (
  id          int primary key default 1 check (id = 1),
  ok          boolean,
  mensaje     text,
  unidades    int,
  sin_asociar text[],
  at          timestamptz
);
insert into public.sitrack_estado (id) values (1) on conflict do nothing;

-- Las alertas pueden venir del rastreador (sin chofer conocido)
alter table public.alertas alter column chofer_id drop not null;
alter table public.alertas add column if not exists origen text not null default 'app';
alter table public.alertas add column if not exists asset_id text;
do $$ begin
  alter table public.alertas add constraint alertas_origen_chk check (origen in ('app', 'satelital'));
exception when duplicate_object then null; end $$;
create index if not exists alertas_asset_idx on public.alertas (asset_id, at desc);

-- Reglas: solo el dueño ve el rastreo y el estado; escribe solo la función del servidor
alter table public.rastreo enable row level security;
alter table public.sitrack_estado enable row level security;
drop policy if exists "dueño ve rastreo" on public.rastreo;
create policy "dueño ve rastreo" on public.rastreo for select to authenticated using (public.es_dueno());
drop policy if exists "dueño ve estado sitrack" on public.sitrack_estado;
create policy "dueño ve estado sitrack" on public.sitrack_estado for select to authenticated using (public.es_dueno());

do $$ declare t text; begin
  foreach t in array array['rastreo', 'sitrack_estado'] loop
    begin execute format('alter publication supabase_realtime add table public.%I', t);
    exception when duplicate_object then null; end;
  end loop;
end $$;

-- Contraseña interna para que solo el reloj automático pueda disparar la función (guardada en la caja fuerte)
do $$ begin
  if not exists (select 1 from vault.secrets where name = 'sitrack_cron_token') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'sitrack_cron_token');
  end if;
end $$;
create or replace function public.sitrack_token() returns text
language sql stable security definer set search_path = '' as $$
  select decrypted_secret from vault.decrypted_secrets where name = 'sitrack_cron_token';
$$;
revoke execute on function public.sitrack_token() from public, anon, authenticated;
grant execute on function public.sitrack_token() to service_role;

-- Cada minuto (Sitrack no acepta consultas más seguidas que cada 30 segundos)
do $$ begin
  if exists (select 1 from cron.job where jobname = 'sitrack') then perform cron.unschedule('sitrack'); end if;
end $$;
select cron.schedule('sitrack', '* * * * *', $job$
  select net.http_post(
    url := 'https://ttfndzxsaoycmzsjycwe.supabase.co/functions/v1/sitrack',
    headers := jsonb_build_object('Content-Type', 'application/json',
      'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'sitrack_cron_token')),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000)
$job$);
