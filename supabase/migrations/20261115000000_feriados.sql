-- Camiones AR — feriados nacionales (Ley 27.399, días turísticos de la Jefatura de Gabinete y feriados especiales).
-- Se usan para la hora pico de los peajes ("sábados, domingos y feriados"). ambito = 'nacional' o la provincia. Solo agrega cosas.
create table if not exists public.feriados (
  fecha      date not null,
  nombre     text not null,
  tipo       text not null check (tipo in ('inamovible', 'trasladable', 'no_laborable', 'turistico', 'especial')),
  ambito     text not null default 'nacional',
  fuente     text,
  fuente_url text,
  primary key (fecha, ambito)
);
alter table public.feriados enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'feriados' and policyname = 'ver feriados') then
    create policy "ver feriados" on public.feriados for select to authenticated using (public.es_miembro());
  end if;
end $$;

insert into public.feriados (fecha, nombre, tipo, ambito, fuente, fuente_url) values
('2026-01-01', 'Año Nuevo', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-02-16', 'Carnaval', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-02-17', 'Carnaval', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-03-23', 'Día no laborable con fines turísticos', 'turistico', 'nacional', 'Res. JGM 164/2025', 'https://www.argentina.gob.ar/normativa/nacional/norma-421799/texto'),
('2026-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-04-03', 'Viernes Santo', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-05-01', 'Día del Trabajo', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-05-25', 'Día de la Revolución de Mayo', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-06-15', 'Paso a la Inmortalidad del Gral. Martín Miguel de Güemes', 'trasladable', 'nacional', 'Ley 27.399 (art. 6, traslado)', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-06-20', 'Paso a la Inmortalidad del Gral. Manuel Belgrano', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-07-09', 'Día de la Independencia', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-07-10', 'Día no laborable con fines turísticos', 'turistico', 'nacional', 'Res. JGM 164/2025', 'https://www.argentina.gob.ar/normativa/nacional/norma-421799/texto'),
('2026-08-17', 'Paso a la Inmortalidad del Gral. José de San Martín', 'trasladable', 'nacional', 'Ley 27.399 (art. 6, traslado)', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-10-12', 'Día del Respeto a la Diversidad Cultural', 'trasladable', 'nacional', 'Ley 27.399 (art. 6, traslado)', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-11-09', 'Visita del Papa León XIV', 'especial', 'nacional', 'DNU 1103/2026', 'https://www.argentina.gob.ar/normativa/nacional/norma-430580/texto'),
('2026-11-10', 'Visita del Papa León XIV', 'especial', 'CABA', 'DNU 1103/2026', 'https://www.argentina.gob.ar/normativa/nacional/norma-430580/texto'),
('2026-11-10', 'Visita del Papa León XIV', 'especial', 'Córdoba', 'DNU 1103/2026', 'https://www.argentina.gob.ar/normativa/nacional/norma-430580/texto'),
('2026-11-11', 'Visita del Papa León XIV', 'especial', 'Buenos Aires', 'DNU 1103/2026', 'https://www.argentina.gob.ar/normativa/nacional/norma-430580/texto'),
('2026-11-23', 'Día de la Soberanía Nacional', 'trasladable', 'nacional', 'Ley 27.399 (art. 6, traslado)', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-12-07', 'Día no laborable con fines turísticos', 'turistico', 'nacional', 'Res. JGM 164/2025', 'https://www.argentina.gob.ar/normativa/nacional/norma-421799/texto'),
('2026-12-08', 'Inmaculada Concepción de María', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2026-12-25', 'Navidad', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-01-01', 'Año Nuevo', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-02-08', 'Carnaval', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-02-09', 'Carnaval', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-03-24', 'Día Nacional de la Memoria por la Verdad y la Justicia', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-03-25', 'Jueves Santo (no laborable)', 'no_laborable', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-03-26', 'Viernes Santo', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-04-02', 'Día del Veterano y de los Caídos en la Guerra de Malvinas', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-05-01', 'Día del Trabajo', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-05-25', 'Día de la Revolución de Mayo', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-06-20', 'Paso a la Inmortalidad del Gral. Manuel Belgrano', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-06-21', 'Paso a la Inmortalidad del Gral. Martín Miguel de Güemes', 'trasladable', 'nacional', 'Ley 27.399 (art. 6, traslado)', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-07-09', 'Día de la Independencia', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-08-16', 'Paso a la Inmortalidad del Gral. José de San Martín', 'trasladable', 'nacional', 'Ley 27.399 (art. 6, traslado)', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-10-11', 'Día del Respeto a la Diversidad Cultural', 'trasladable', 'nacional', 'Ley 27.399 (art. 6, traslado)', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-11-20', 'Día de la Soberanía Nacional', 'trasladable', 'nacional', 'Ley 27.399 (art. 6, traslado)', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-12-08', 'Inmaculada Concepción de María', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto'),
('2027-12-25', 'Navidad', 'inamovible', 'nacional', 'Ley 27.399', 'https://www.argentina.gob.ar/normativa/nacional/norma-281835/texto')
on conflict (fecha, ambito) do nothing;
