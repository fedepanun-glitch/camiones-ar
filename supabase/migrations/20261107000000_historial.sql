-- Camiones AR — alertas por tramo, recorrido del día, llegadas y salidas, resumen semanal y solo lectura.
-- Solo agrega cosas (no borra nada). Se puede correr más de una vez.

-- ---------- Solo lectura ----------
-- Un administrador "solo lectura" ve todo el panel pero no puede cambiar nada.
alter table public.perfiles add column if not exists solo_lectura boolean not null default false;

-- Puede cambiar cosas: dueño o administrador que no sea de solo lectura
create or replace function public.es_dueno() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol in ('dueno', 'admin') and not solo_lectura);
$$;
-- Puede ver el panel: dueño o cualquier administrador
create or replace function public.es_panel() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol in ('dueno', 'admin'));
$$;
grant execute on function public.es_panel() to authenticated;

-- Lectura para los de solo lectura (se suman a las reglas que ya había)
do $$ declare t text; begin
  foreach t in array array['perfiles', 'viajes', 'posiciones', 'alertas', 'rastreo', 'sitrack_estado'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = 'panel ve ' || t) then
      execute format('create policy %I on public.%I for select to authenticated using (public.es_panel())', 'panel ve ' || t, t);
    end if;
  end loop;
end $$;

-- ---------- Alertas por tramo ----------
-- Una alerta por cada tramo de exceso: velocidad = la máxima del tramo, fin = hasta cuándo duró
alter table public.alertas add column if not exists fin timestamptz;
alter table public.alertas add column if not exists direccion text;
-- El chofer actualiza su propia alerta mientras dura el tramo (máxima y fin)
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'alertas' and policyname = 'chofer actualiza su alerta') then
    create policy "chofer actualiza su alerta" on public.alertas for update to authenticated
      using (chofer_id = auth.uid()) with check (chofer_id = auth.uid());
  end if;
end $$;

-- ---------- Recorrido del día ----------
create table if not exists public.recorridos (
  id         bigint generated always as identity primary key,
  camion_id  uuid references public.camiones(id) on delete set null,
  chofer_id  uuid references public.perfiles(id) on delete set null,
  asset_id   text,
  fuente     text not null check (fuente in ('satelital', 'app')),
  lat        double precision not null,
  lon        double precision not null,
  velocidad  real,
  at         timestamptz not null default now()
);
create index if not exists recorridos_camion_idx on public.recorridos (camion_id, at);
create index if not exists recorridos_chofer_idx on public.recorridos (chofer_id, at);
create index if not exists recorridos_at_idx on public.recorridos (at);
alter table public.recorridos enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'recorridos' and policyname = 'panel ve recorridos') then
    create policy "panel ve recorridos" on public.recorridos for select to authenticated using (public.es_panel());
  end if;
end $$;

-- ---------- Llegadas y salidas ----------
create table if not exists public.eventos (
  id         bigint generated always as identity primary key,
  tipo       text not null check (tipo in ('llegada', 'salida')),
  lugar_id   uuid references public.lugares(id) on delete cascade,
  camion_id  uuid references public.camiones(id) on delete set null,
  chofer_id  uuid references public.perfiles(id) on delete set null,
  asset_id   text,
  at         timestamptz not null default now()
);
create index if not exists eventos_at_idx on public.eventos (at desc);
alter table public.eventos enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'eventos' and policyname = 'panel ve eventos') then
    create policy "panel ve eventos" on public.eventos for select to authenticated using (public.es_panel());
  end if;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.eventos;
exception when duplicate_object then null; end $$;

-- Distancia en metros (aproximada, sobra para distancias cortas)
create or replace function public.metros(lat1 double precision, lon1 double precision, lat2 double precision, lon2 double precision)
returns double precision language sql immutable as $$
  select 6371000 * sqrt(power(radians(lat2 - lat1), 2) + power(radians(lon2 - lon1) * cos(radians((lat1 + lat2) / 2)), 2));
$$;

-- Lugar de la empresa donde está un punto (a menos de 250 m), o null
create or replace function public.lugar_en(p_lat double precision, p_lon double precision) returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.lugares
  where lat between p_lat - 0.003 and p_lat + 0.003 and lon between p_lon - 0.004 and p_lon + 0.004
    and public.metros(lat, lon, p_lat, p_lon) < 250
  order by public.metros(lat, lon, p_lat, p_lon) limit 1;
$$;

-- Guarda el punto en el recorrido y registra llegadas/salidas (lo usan los dos disparadores de abajo)
create or replace function public.registrar_punto(p_fuente text, p_camion uuid, p_chofer uuid, p_asset text,
  p_lat_ant double precision, p_lon_ant double precision, p_lat double precision, p_lon double precision,
  p_vel real, p_at timestamptz) returns void
language plpgsql security definer set search_path = public as $$
declare antes uuid; ahora uuid;
begin
  insert into public.recorridos (camion_id, chofer_id, asset_id, fuente, lat, lon, velocidad, at)
  values (p_camion, p_chofer, p_asset, p_fuente, p_lat, p_lon, p_vel, coalesce(p_at, now()));
  if p_lat_ant is null or p_camion is null and p_chofer is null then return; end if;
  antes := public.lugar_en(p_lat_ant, p_lon_ant);
  ahora := public.lugar_en(p_lat, p_lon);
  if antes is not distinct from ahora then return; end if;
  -- Si el mismo camión ya avisó lo mismo hace poco (por la app y por Sitrack), no se repite
  if antes is not null and not exists (select 1 from public.eventos where tipo = 'salida' and lugar_id = antes
      and (camion_id = p_camion or chofer_id = p_chofer) and at > now() - interval '10 minutes') then
    insert into public.eventos (tipo, lugar_id, camion_id, chofer_id, asset_id) values ('salida', antes, p_camion, p_chofer, p_asset);
  end if;
  if ahora is not null and not exists (select 1 from public.eventos where tipo = 'llegada' and lugar_id = ahora
      and (camion_id = p_camion or chofer_id = p_chofer) and at > now() - interval '10 minutes') then
    insert into public.eventos (tipo, lugar_id, camion_id, chofer_id, asset_id) values ('llegada', ahora, p_camion, p_chofer, p_asset);
  end if;
end $$;
revoke execute on function public.registrar_punto(text, uuid, uuid, text, double precision, double precision, double precision, double precision, real, timestamptz) from public, anon, authenticated;

create or replace function public.tr_rastreo_punto() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.lat is null or new.lon is null then return new; end if;
  if tg_op = 'UPDATE' and new.reporte_at is not distinct from old.reporte_at then return new; end if;  -- sin reporte nuevo
  perform public.registrar_punto('satelital', new.camion_id, null, new.asset_id,
    case when tg_op = 'UPDATE' then old.lat end, case when tg_op = 'UPDATE' then old.lon end,
    new.lat, new.lon, new.velocidad, new.reporte_at);
  return new;
end $$;
create or replace trigger rastreo_punto after insert or update on public.rastreo
  for each row execute function public.tr_rastreo_punto();

create or replace function public.tr_posicion_punto() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' and new.lat = old.lat and new.lon = old.lon then return new; end if;   -- no se movió
  perform public.registrar_punto('app', new.camion_id, new.chofer_id, null,
    case when tg_op = 'UPDATE' then old.lat end, case when tg_op = 'UPDATE' then old.lon end,
    new.lat, new.lon, new.velocidad, new.at);
  return new;
end $$;
create or replace trigger posicion_punto after insert or update on public.posiciones
  for each row execute function public.tr_posicion_punto();

-- Se guardan 90 días de recorridos (todos los días a las 4 de la mañana se borran los más viejos)
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'limpiar_recorridos') then
    perform cron.schedule('limpiar_recorridos', '0 7 * * *', $job$delete from public.recorridos where at < now() - interval '90 days'$job$);
  end if;
end $$;

-- ---------- Resumen ----------
-- Km, viajes y excesos por camión y por chofer entre dos fechas (hora de Argentina)
create or replace function public.resumen(p_desde date, p_hasta date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare d timestamptz := (p_desde::timestamp at time zone 'America/Argentina/Buenos_Aires');
        h timestamptz := ((p_hasta + 1)::timestamp at time zone 'America/Argentina/Buenos_Aires');
        res jsonb;
begin
  if not public.es_panel() then raise exception 'sin permiso'; end if;
  with pts as (
    select camion_id, chofer_id, fuente, lat, lon, at,
      lag(lat) over w as lat0, lag(lon) over w as lon0, lag(at) over w as at0
    from public.recorridos where at >= d and at < h and (camion_id is not null or chofer_id is not null)
    window w as (partition by fuente, coalesce(camion_id::text, chofer_id::text) order by at)),
  tramos as (
    -- se descartan saltos imposibles (más de 150 km/h promedio entre dos puntos)
    select camion_id, chofer_id, fuente, public.metros(lat0, lon0, lat, lon) as m
    from pts where lat0 is not null and at > at0
      and public.metros(lat0, lon0, lat, lon) / extract(epoch from (at - at0)) < 42),
  km_cam as (  -- por camión: preferir Sitrack; si no hay, lo de la app
    select camion_id, coalesce(sum(m) filter (where fuente = 'satelital'), 0) as sat, coalesce(sum(m) filter (where fuente = 'app'), 0) as app
    from tramos where camion_id is not null group by camion_id),
  km_chof as (select chofer_id, sum(m) as m from tramos where chofer_id is not null and fuente = 'app' group by chofer_id),
  ex_cam as (select camion_id, count(*) n, max(velocidad) vmax from public.alertas where at >= d and at < h and camion_id is not null group by camion_id),
  ex_chof as (select chofer_id, count(*) n, max(velocidad) vmax from public.alertas where at >= d and at < h and chofer_id is not null group by chofer_id),
  vi_cam as (select camion_id, count(*) n from public.viajes where estado = 'terminado' and terminado >= d and terminado < h and camion_id is not null group by camion_id),
  vi_chof as (select chofer_id, count(*) n from public.viajes where estado = 'terminado' and terminado >= d and terminado < h and chofer_id is not null group by chofer_id)
  select jsonb_build_object(
    'camiones', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'nombre', c.nombre,
        'km', round((greatest(coalesce(k.sat, 0), coalesce(k.app, 0)) / 1000)::numeric, 1),
        'viajes', coalesce(v.n, 0), 'excesos', coalesce(e.n, 0), 'vmax', e.vmax) order by c.nombre)
      from public.camiones c left join km_cam k on k.camion_id = c.id left join ex_cam e on e.camion_id = c.id left join vi_cam v on v.camion_id = c.id
      where c.activo), '[]'::jsonb),
    'choferes', coalesce((select jsonb_agg(jsonb_build_object('id', p.id, 'nombre', p.nombre,
        'km', round((coalesce(k.m, 0) / 1000)::numeric, 1), 'viajes', coalesce(v.n, 0), 'excesos', coalesce(e.n, 0), 'vmax', e.vmax) order by p.nombre)
      from public.perfiles p left join km_chof k on k.chofer_id = p.id left join ex_chof e on e.chofer_id = p.id left join vi_chof v on v.chofer_id = p.id
      where p.rol = 'chofer'), '[]'::jsonb)
  ) into res;
  return res;
end $$;
grant execute on function public.resumen(date, date) to authenticated;
