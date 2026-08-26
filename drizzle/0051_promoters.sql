-- Tarea 9.1 — Promotores (visión §2.8: "cuánto vendió cada promotor"). Aditiva, no toca filas
-- existentes. Los promotores viven a nivel TENANT (una productora tiene los suyos, trabajan en
-- varios eventos) y cada venta los referencia por id:
--   `promoters`          — la persona (nombre + teléfono opcional). Se "borran" con `is_active =
--                          false` (soft delete): las ventas históricas siguen apuntándolos.
--   `sales.promoter_id`  — atribución de la venta de barra/caja al promotor que la originó.
--   `tickets.promoter_id`— atribución de la entrada (venta manual/puerta) al promotor.
-- El reporte por promotor (tarea 9.2) agrupa por estas columnas.
CREATE TABLE `promoters` (
	`id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`phone` varchar(32) NULL,
	`is_active` boolean NOT NULL DEFAULT TRUE,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `promoters_id` PRIMARY KEY(`id`),
	CONSTRAINT `promoters_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action
);
CREATE INDEX `promoters_tenant_id_idx` ON `promoters` (`tenant_id`);

ALTER TABLE `sales`
  ADD COLUMN `promoter_id` varchar(36) NULL,
  ADD CONSTRAINT `sales_promoter_id_promoters_id_fk` FOREIGN KEY (`promoter_id`) REFERENCES `promoters`(`id`) ON DELETE no action ON UPDATE no action;
CREATE INDEX `sales_promoter_id_idx` ON `sales` (`promoter_id`);

ALTER TABLE `tickets`
  ADD COLUMN `promoter_id` varchar(36) NULL,
  ADD CONSTRAINT `tickets_promoter_id_promoters_id_fk` FOREIGN KEY (`promoter_id`) REFERENCES `promoters`(`id`) ON DELETE no action ON UPDATE no action;
CREATE INDEX `tickets_promoter_id_idx` ON `tickets` (`promoter_id`);
