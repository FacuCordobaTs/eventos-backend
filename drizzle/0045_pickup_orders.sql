-- Tarea 4.1/4.2 — Retiro en barra (visión §2.5): el cliente elige qué tragos comprados y no
-- canjeados se lleva ahora, y el sistema le genera UN QR de pedido. Cada fila es UN pedido de
-- una o más consumiciones PENDING de `digital_consumptions` (que NO se tocan al crearlo: lo no
-- retirado sigue disponible). `items_json` guarda la lista `[{consumptionId, productId, quantity}]`
-- en orden estable por consumptionId (para detectar pedidos duplicados). El canje en lote
-- (marca REDEEMED + descuento de stock una vez por producto) lo hace la barra con el token del
-- QR (tarea 4.2/4.3). Aditiva: no toca datos existentes.
CREATE TABLE `pickup_orders` (
  `id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `customer_id` varchar(36) NOT NULL,
  `token` varchar(64) NOT NULL,
  `status` enum('PENDING','DELIVERED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  `items_json` json NULL,
  `delivered_at` timestamp NULL,
  `delivered_by` varchar(36) NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `pickup_orders_id` PRIMARY KEY(`id`),
  CONSTRAINT `pickup_orders_token_unique` UNIQUE(`token`),
  CONSTRAINT `pickup_orders_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
  CONSTRAINT `pickup_orders_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
  CONSTRAINT `pickup_orders_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`),
  CONSTRAINT `pickup_orders_delivered_by_staff_id_fk` FOREIGN KEY (`delivered_by`) REFERENCES `staff`(`id`)
);
CREATE INDEX `pickup_orders_event_tenant_idx` ON `pickup_orders` (`event_id`,`tenant_id`);
CREATE INDEX `pickup_orders_customer_idx` ON `pickup_orders` (`customer_id`);
CREATE INDEX `pickup_orders_status_idx` ON `pickup_orders` (`status`);
