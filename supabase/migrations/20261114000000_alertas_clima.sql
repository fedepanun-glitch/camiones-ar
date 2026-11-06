-- Camiones AR — alertas meteorológicas del Servicio Meteorológico Nacional (SMN) sobre el camino.
-- La función "clima" lee cada 15 minutos el listado oficial de alertas (formato CAP, con el polígono de cada zona)
-- y lo copia a esta tabla. La función "rutas" avisa si el viaje cruza una zona con alerta mientras rige. Solo agrega cosas.
create table if not exists public.alertas_clima (
  url          text primary key,                -- el XML CAP de la alerta
  identificador text,
  evento       text not null,                   -- Tormentas, Viento, Viento Zonda, Lluvias, Nevadas, Niebla…
  nivel        text,                            -- amarilla / naranja / roja
  severidad    text,                            -- Minor / Moderate / Severe / Extreme (CAP)
  desde        timestamptz,
  hasta        timestamptz,
  descripcion  text,
  instruccion  text,
  area         extensions.geometry(MultiPolygon, 4326) not null,
  at           timestamptz not null default now()
);
create index if not exists alertas_clima_area on public.alertas_clima using gist (area);
alter table public.alertas_clima enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'alertas_clima' and policyname = 'ver alertas clima') then
    create policy "ver alertas clima" on public.alertas_clima for select to authenticated using (public.es_miembro());
  end if;
end $$;

-- Alertas que toca un camino: dónde entra (metros desde la salida) y cuánto recorre adentro.
-- Se juntan las alertas iguales (mismo evento, nivel y horario) que vienen partidas en varios polígonos.
create or replace function public.clima_en_ruta(linea jsonb)
returns table (evento text, nivel text, severidad text, desde timestamptz, hasta timestamptz, descripcion text,
               instruccion text, entra double precision, sale double precision)
language sql stable security definer set search_path = public, extensions as $$
  with l as (select st_setsrid(st_geomfromgeojson(linea::text), 4326) g),
  len as (select st_length(g::geography) m from l),
  a as (
    select ac.*, st_intersection(l.g, ac.area) x
    from alertas_clima ac, l
    where ac.area && l.g and st_intersects(ac.area, l.g) and (ac.hasta is null or ac.hasta > now())
  ),
  p as (
    select a.evento, a.nivel, a.severidad, a.desde, a.hasta, a.descripcion, a.instruccion,
           (select min(st_linelocatepoint(l.g, st_startpoint(d.geom))) from st_dump(st_linemerge(st_collectionextract(a.x, 2))) d, l) * len.m e,
           (select max(st_linelocatepoint(l.g, st_endpoint(d.geom))) from st_dump(st_linemerge(st_collectionextract(a.x, 2))) d, l) * len.m s
    from a, len
  )
  select evento, nivel, max(severidad), desde, hasta, max(descripcion), max(instruccion), min(e), max(s)
  from p where e is not null
  group by evento, nivel, desde, hasta
  order by min(e)
  limit 30
$$;
revoke execute on function public.clima_en_ruta(jsonb) from public, anon;
grant execute on function public.clima_en_ruta(jsonb) to authenticated, service_role;

-- Cada 15 minutos se actualizan las alertas del SMN
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'clima_smn') then
    perform cron.schedule('clima_smn', '*/15 * * * *', $job$
      select net.http_post(
        url := 'https://ttfndzxsaoycmzsjycwe.supabase.co/functions/v1/clima',
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-cron-token', (select decrypted_secret from vault.decrypted_secrets where name = 'sitrack_cron_token')),
        body := '{}'::jsonb,
        timeout_milliseconds := 120000)
    $job$);
  end if;
end $$;
