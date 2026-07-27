-- Tarea 1.6 — Compra de mercadería como registro único (spec §0/§4.3/§4.6).
-- Una compra sube stock del evento y asienta el costo a la vez. El insumo nace implícito y la
-- cantidad se carga en unidad contable (botellas/latas). Cada compra enlaza el gasto que generó
-- vía event_expenses.purchase_id (relación 1:1, para no duplicar el costo).
-- Aditiva: crea la tabla `purchases` y agrega la columna/índice/FK `purchase_id` a event_expenses.
-- No toca datos existentes (los gastos viejos quedan con purchase_id = NULL = operativos).
-- Mismo patrón SQL-a-mano de 0032–0036 (no toca _journal.json / meta).

CREATE TABLE `purchases` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `inventory_item_id` varchar(36) NOT NULL,
  `quantity` decimal(12,2) NOT NULL,
  `counting_unit` varchar(50) NOT NULL DEFAULT 'unidad',
  `total_cost` decimal(12,2) NOT NULL DEFAULT '0',
  `note` varchar(255) NULL,
  `created_by` varchar(36) NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `purchases_id` PRIMARY KEY(`id`),
  CONSTRAINT `purchases_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
  CONSTRAINT `purchases_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
  CONSTRAINT `purchases_inventory_item_id_inventory_items_id_fk` FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`),
  CONSTRAINT `purchases_created_by_staff_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`)
);
CREATE INDEX `purchases_tenant_idx` ON `purchases` (`tenant_id`);
CREATE INDEX `purchases_event_tenant_idx` ON `purchases` (`event_id`,`tenant_id`);
CREATE INDEX `purchases_item_idx` ON `purchases` (`inventory_item_id`);

ALTER TABLE `event_expenses`
  ADD COLUMN `purchase_id` varchar(36) NULL,
  ADD CONSTRAINT `event_expenses_purchase_id_purchases_id_fk` FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`);
CREATE INDEX `event_expenses_purchase_idx` ON `event_expenses` (`purchase_id`);
