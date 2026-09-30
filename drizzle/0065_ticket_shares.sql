-- Compartir entradas: quien compra varias entradas arma un link (`crow.ar/t/{token}`) para mandar al
-- grupo y cada amigo reclama una, dejando sus datos como cliente (nombre, DNI, celular, email).
--
-- `ticket_shares`     — el link. Reparte un solo tipo de entrada; `token` es la capability pública
--                       (sin auth) y `cancelled_at` lo da de baja sin deshacer lo ya reclamado. La fila
--                       es también el punto de serialización del canje (se bloquea con FOR UPDATE).
-- `ticket_transfers`  — un cupo del link: una entrada concreta reservada. PENDING (reservada, sigue
--                       siendo del dueño), CLAIMED (la reclamó `to_customer_id`; la fila de `tickets`
--                       ya pasó a su nombre y cambió de QR) o VOID (no se pudo entregar). Es además el
--                       historial de traspasos. La venta y el promotor de la entrada NO cambian.
--                       `to_name` es el nombre tal cual lo escribió quien reclamó (lo que ve el dueño).
--
-- El unique (share_id, to_customer_id) impone una entrada por persona y por link; los NULL de los
-- cupos todavía sin reclamar no chocan entre sí en MySQL.
-- Aditiva: no toca filas existentes. Aplicar antes de desplegar el backend.
CREATE TABLE `ticket_shares` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `ticket_type_id` varchar(36) NOT NULL,
  `owner_customer_id` varchar(36) NOT NULL,
  `token` varchar(64) NOT NULL,
  `cancelled_at` timestamp NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `ticket_shares_id` PRIMARY KEY(`id`),
  CONSTRAINT `ticket_shares_token_unique` UNIQUE(`token`),
  CONSTRAINT `ticket_shares_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
  CONSTRAINT `ticket_shares_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
  CONSTRAINT `ticket_shares_ticket_type_id_ticket_types_id_fk` FOREIGN KEY (`ticket_type_id`) REFERENCES `ticket_types`(`id`),
  CONSTRAINT `ticket_shares_owner_customer_id_customers_id_fk` FOREIGN KEY (`owner_customer_id`) REFERENCES `customers`(`id`)
);
CREATE INDEX `ticket_shares_owner_event_idx` ON `ticket_shares` (`owner_customer_id`,`event_id`);
CREATE INDEX `ticket_shares_event_tenant_idx` ON `ticket_shares` (`event_id`,`tenant_id`);

CREATE TABLE `ticket_transfers` (
  `id` varchar(36) NOT NULL,
  `share_id` varchar(36) NOT NULL,
  `ticket_id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `from_customer_id` varchar(36) NOT NULL,
  `to_customer_id` varchar(36) NULL,
  `to_name` varchar(255) NULL,
  `position` int NOT NULL DEFAULT 0,
  `status` enum('PENDING','CLAIMED','VOID') NOT NULL DEFAULT 'PENDING',
  `claimed_at` timestamp NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `ticket_transfers_id` PRIMARY KEY(`id`),
  CONSTRAINT `ticket_transfers_share_id_ticket_shares_id_fk` FOREIGN KEY (`share_id`) REFERENCES `ticket_shares`(`id`),
  CONSTRAINT `ticket_transfers_ticket_id_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`),
  CONSTRAINT `ticket_transfers_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
  CONSTRAINT `ticket_transfers_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
  CONSTRAINT `ticket_transfers_from_customer_id_customers_id_fk` FOREIGN KEY (`from_customer_id`) REFERENCES `customers`(`id`),
  CONSTRAINT `ticket_transfers_to_customer_id_customers_id_fk` FOREIGN KEY (`to_customer_id`) REFERENCES `customers`(`id`)
);
CREATE INDEX `ticket_transfers_share_status_idx` ON `ticket_transfers` (`share_id`,`status`,`position`);
CREATE INDEX `ticket_transfers_ticket_status_idx` ON `ticket_transfers` (`ticket_id`,`status`);
CREATE INDEX `ticket_transfers_to_customer_idx` ON `ticket_transfers` (`to_customer_id`);
CREATE INDEX `ticket_transfers_event_tenant_idx` ON `ticket_transfers` (`event_id`,`tenant_id`);
CREATE UNIQUE INDEX `ticket_transfers_share_claimant_unique` ON `ticket_transfers` (`share_id`,`to_customer_id`);
