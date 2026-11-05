-- Camiones AR — reportes de los choferes (como Waze, pero solo para camiones).
-- Cada reporte vence solo según el tipo; si otro chofer lo confirma, dura más.
-- "corte" se esquiva en las rutas; los demás se avisan al acercarse. Solo agrega cosas.

create table if not exists public.reportes (
  id             uuid primary key default gen_random_uuid(),
  tipo           text not null check (tipo in ('bache', 'camino_roto', 'control', 'balanza', 'corte', 'altura', 'angosta', 'otro')),
  lat            double precision not null check (lat between -56 and -21),
  lon            double precision not null check (lon between -74 and -53),
  dato           real,                         -- altura en metros (puente bajo), si se sabe
  nota           text,
  creado_por     uuid default auth.uid() references public.perfiles(id) on delete set null,
  creado         timestamptz not null default now(),
  vence          timestamptz,                  -- vacío = no vence (balanza, puente bajo, calle angosta)
  confirmaciones int not null default 0,
  activo         boolean not null default true
);
create index if not exists reportes_activos_idx on public.reportes (lat, lon) where activo;

alter table public.reportes enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reportes' and policyname = 'ver reportes') then
    create policy "ver reportes" on public.reportes for select to authenticated using (public.es_miembro());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reportes' and policyname = 'crear reporte') then
    create policy "crear reporte" on public.reportes for insert to authenticated with check (public.es_miembro() and creado_por = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reportes' and policyname = 'sacar reporte') then
    create policy "sacar reporte" on public.reportes for update to authenticated using (public.es_dueno() or creado_por = auth.uid()) with check (public.es_dueno() or creado_por = auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reportes' and policyname = 'borrar reporte') then
    create policy "borrar reporte" on public.reportes for delete to authenticated using (public.es_dueno() or creado_por = auth.uid());
  end if;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.reportes;
exception when duplicate_object then null; end $$;

-- Cuánto dura cada tipo de reporte
create or replace function public.vigencia_reporte(p_tipo text) returns interval language sql immutable as $$
  select case p_tipo when 'control' then interval '3 hours' when 'corte' then interval '1 day'
    when 'bache' then interval '30 days' when 'camino_roto' then interval '30 days' when 'otro' then interval '7 days' else null end;
$$;
create or replace function public.tr_reporte_vence() returns trigger language plpgsql as $$
begin
  if new.vence is null and public.vigencia_reporte(new.tipo) is not null then new.vence := now() + public.vigencia_reporte(new.tipo); end if;
  return new;
end $$;
create or replace trigger reporte_vence before insert on public.reportes for each row execute function public.tr_reporte_vence();

-- "Sigue ahí": otro chofer confirma el reporte y se renueva el vencimiento
create or replace function public.confirmar_reporte(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.es_miembro() then raise exception 'sin permiso'; end if;
  update public.reportes set confirmaciones = confirmaciones + 1,
    vence = case when vence is null then null else now() + public.vigencia_reporte(tipo) end
  where id = p_id and activo;
end $$;
grant execute on function public.confirmar_reporte(uuid) to authenticated;

-- Los vencidos se desactivan solos (cada hora)
do $$ begin
  if not exists (select 1 from cron.job where jobname = 'vencer_reportes') then
    perform cron.schedule('vencer_reportes', '15 * * * *', $job$update public.reportes set activo = false where activo and vence < now()$job$);
  end if;
end $$;
