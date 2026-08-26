-- Tarea 3.1 — Restricción de edad del evento (visión §2.4: "Si el evento es +18, el DNI trae
-- la fecha de nacimiento y lo valida solo"). Edad mínima para entrar (ej. 18) o NULL = sin
-- restricción. La lee el escáner de DNI del admin: con la `birthDate` del código de barras
-- bloquea menores antes de validar el ticket.
ALTER TABLE `events` ADD COLUMN `age_restriction` INT NULL;

