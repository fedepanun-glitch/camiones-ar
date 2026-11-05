-- Camiones AR — nuevo tipo de reporte de los choferes: "inseguro" (zona insegura: robos, piratas del asfalto).
-- Dura 60 días; si otro chofer lo confirma, se renueva.
alter table public.reportes drop constraint if exists reportes_tipo_check;
alter table public.reportes add constraint reportes_tipo_check check (tipo in ('bache', 'camino_roto', 'control', 'balanza', 'corte', 'altura', 'angosta', 'otro', 'inseguro'));
create or replace function public.vigencia_reporte(p_tipo text) returns interval language sql immutable as $$
  select case p_tipo when 'control' then interval '3 hours' when 'corte' then interval '1 day'
    when 'bache' then interval '30 days' when 'camino_roto' then interval '30 days' when 'otro' then interval '7 days'
    when 'inseguro' then interval '60 days' else null end;
$$;
