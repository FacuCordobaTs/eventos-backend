-- Máquina de estados del evento (spec §0/§5, ver src/lib/event-status.ts).
-- Agrega `status` (4 estados) + timestamps de apertura/cierre (programada y efectiva).
ALTER TABLE `events` ADD COLUMN `status` enum('draft','on_sale','live','closed') NOT NULL DEFAULT 'draft';
ALTER TABLE `events` ADD COLUMN `doors_at` timestamp NULL;
ALTER TABLE `events` ADD COLUMN `sales_opened_at` timestamp NULL;
ALTER TABLE `events` ADD COLUMN `went_live_at` timestamp NULL;
ALTER TABLE `events` ADD COLUMN `closed_at` timestamp NULL;

-- Backfill del estado a partir de la derivación previa (isActive + fecha):
--   isActive = false            -> 'draft'
--   fecha en el pasado          -> 'closed'  (antes "finished")
--   en otro caso                -> 'on_sale' (antes "active")
-- El estado 'live' no existía en el modelo viejo, así que no se produce por backfill.
UPDATE `events` SET `status` = CASE
  WHEN `is_active` = 0 THEN 'draft'
  WHEN `date` < NOW() THEN 'closed'
  ELSE 'on_sale'
END;
