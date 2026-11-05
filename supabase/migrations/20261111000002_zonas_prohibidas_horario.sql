-- Camiones AR — horario de las zonas prohibidas (p. ej. Zárate centro: lunes a viernes 11–13 y 16–18 h).
-- Vacío = rige siempre. Si no: {"dias":[1..7 (1=lunes)], "franjas":[["11:00","13:00"],…]} en hora de Argentina.
alter table public.zonas_prohibidas add column if not exists horario jsonb;
