-- Venta de consumos por canal: página pública del evento y link de acceso.
-- Ambos canales nacen habilitados para conservar el comportamiento anterior.
ALTER TABLE `events` ADD COLUMN `consumptions_on_page_enabled` boolean NOT NULL DEFAULT true;
ALTER TABLE `events` ADD COLUMN `consumptions_on_access_link_enabled` boolean NOT NULL DEFAULT true;
