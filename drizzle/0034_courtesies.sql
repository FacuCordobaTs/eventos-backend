-- Cortesías / invitaciones (spec §4.2): links nominados que emiten una entrada, contados aparte.
-- Cada fila es una invitación a nombre de una persona; su `token` arma el link público de canje.
-- Al canjearse emite UNA entrada real en `tickets` (para que el acceso funcione igual) enlazada
-- por `ticket_id`. Una entrada es cortesía sii una fila de acá la referencia (así se cuentan aparte).
-- Aditiva: no toca datos existentes.
CREATE TABLE `courtesies` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `ticket_type_id` varchar(36) NOT NULL,
  `guest_name` varchar(255) NOT NULL,
  `guest_email` varchar(255) NULL,
  `token` varchar(64) NOT NULL,
  `status` enum('PENDING','REDEEMED','REVOKED') NOT NULL DEFAULT 'PENDING',
  `ticket_id` varchar(36) NULL,
  `redeemed_at` timestamp NULL,
  `created_by` varchar(36) NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `courtesies_id` PRIMARY KEY(`id`),
  CONSTRAINT `courtesies_token_unique` UNIQUE(`token`),
  CONSTRAINT `courtesies_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
  CONSTRAINT `courtesies_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
  CONSTRAINT `courtesies_ticket_type_id_ticket_types_id_fk` FOREIGN KEY (`ticket_type_id`) REFERENCES `ticket_types`(`id`),
  CONSTRAINT `courtesies_ticket_id_tickets_id_fk` FOREIGN KEY (`ticket_id`) REFERENCES `tickets`(`id`),
  CONSTRAINT `courtesies_created_by_staff_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`)
);
CREATE INDEX `courtesies_tenant_id_idx` ON `courtesies` (`tenant_id`);
CREATE INDEX `courtesies_event_tenant_idx` ON `courtesies` (`event_id`,`tenant_id`);
CREATE INDEX `courtesies_ticket_type_idx` ON `courtesies` (`ticket_type_id`);
CREATE INDEX `courtesies_ticket_id_idx` ON `courtesies` (`ticket_id`);
