-- Horario de uso por tipo de entrada. Las entradas existentes no tienen restricciones.
-- Aplicar antes de desplegar el backend.
ALTER TABLE `ticket_types`
  ADD COLUMN `valid_from` timestamp NULL DEFAULT NULL,
  ADD COLUMN `valid_until` timestamp NULL DEFAULT NULL;
