-- Tandas: escalera de precios por tipo de entrada (spec §4.2, ver src/lib/ticket-tiers.ts).
-- Cada fila es una tanda de un ticketType, ordenada por `position`. Las tandas se consumen
-- en secuencia (por cupos) y/o por ventana de fecha; el sistema las ejecuta solo en lectura.
-- Un ticketType sin filas acá conserva el comportamiento plano actual (precio/stock del tipo).
CREATE TABLE `ticket_tiers` (
  `id` varchar(36) NOT NULL,
  `ticket_type_id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `name` varchar(100) NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `position` int NOT NULL DEFAULT 0,
  `stock_limit` int NULL,
  `active_from` timestamp NULL,
  `active_until` timestamp NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `ticket_tiers_id` PRIMARY KEY(`id`),
  CONSTRAINT `ticket_tiers_ticket_type_id_ticket_types_id_fk` FOREIGN KEY (`ticket_type_id`) REFERENCES `ticket_types`(`id`),
  CONSTRAINT `ticket_tiers_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
  CONSTRAINT `ticket_tiers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);
CREATE INDEX `ticket_tiers_tenant_id_idx` ON `ticket_tiers` (`tenant_id`);
CREATE INDEX `ticket_tiers_ticket_type_idx` ON `ticket_tiers` (`ticket_type_id`,`position`);
CREATE INDEX `ticket_tiers_event_tenant_idx` ON `ticket_tiers` (`event_id`,`tenant_id`);
