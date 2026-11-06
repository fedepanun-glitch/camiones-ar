-- Camiones AR — reglas locales que no se esquivan sino que se avisan (estacionamiento, carga y descarga,
-- red obligatoria de la ciudad) cuando el viaje empieza o termina dentro de esa ciudad.
alter table public.zonas_prohibidas add column if not exists solo_aviso boolean not null default false;
