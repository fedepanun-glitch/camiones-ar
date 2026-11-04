-- Camiones AR — documentos oficiales descargados (normas, anexos, listados) para cargar restricciones con su fuente.
-- Los descarga la función "fuentes" (solo sitios del gobierno y una lista permitida). Solo agrega cosas.
create table if not exists public.fuentes_docs (
  url       text primary key,
  tipo      text,                 -- pdf, html, json, csv, texto
  titulo    text,
  texto     text,                 -- texto extraído
  enlaces   jsonb,                -- enlaces que aparecen en la página (para seguir a anexos)
  bytes     int,
  estado    int,                  -- código HTTP
  at        timestamptz not null default now()
);
alter table public.fuentes_docs enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'fuentes_docs' and policyname = 'panel ve fuentes') then
    create policy "panel ve fuentes" on public.fuentes_docs for select to authenticated using (public.es_panel());
  end if;
end $$;

-- Copia del archivo original (base64), para documentos escaneados que hay que leer como imagen
alter table public.fuentes_docs add column if not exists archivo_b64 text;
