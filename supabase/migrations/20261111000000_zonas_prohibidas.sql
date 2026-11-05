-- Camiones AR — zonas donde ciertos camiones no pueden entrar (ordenanzas municipales).
-- Ejemplo: Rosario, Ord. 4703/1989: prohibidos semirremolques y camiones con acoplado en un sector de la ciudad.
-- La función "rutas" las esquiva cuando el camión cumple la condición (largo o peso), salvo que el viaje
-- empiece o termine adentro (en ese caso hace falta el permiso municipal y se avisa). Solo agrega cosas.
create table if not exists public.zonas_prohibidas (
  id          text primary key,
  nombre      text not null,
  anillo      jsonb not null,               -- [[lon, lat], …] (cerrado)
  largo_min   real,                         -- aplica a camiones de este largo o más (m)
  peso_min    real,                         -- aplica a camiones de este peso o más (t)
  nota        text,
  fuente      text,
  fuente_url  text,
  activo      boolean not null default true,
  creado      timestamptz not null default now()
);
alter table public.zonas_prohibidas enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'zonas_prohibidas' and policyname = 'ver zonas prohibidas') then
    create policy "ver zonas prohibidas" on public.zonas_prohibidas for select to authenticated using (public.es_miembro());
  end if;
end $$;
