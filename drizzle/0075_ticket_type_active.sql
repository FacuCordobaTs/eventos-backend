-- Los tipos existentes siguen disponibles. Desactivar sólo detiene nuevas ventas.
ALTER TABLE `ticket_types`
  ADD COLUMN `is_active` boolean NOT NULL DEFAULT true;
