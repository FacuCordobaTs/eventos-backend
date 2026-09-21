-- Códigos de un solo uso para que un cliente entre con DNI o celular desde el link por evento
-- (crow.ar/{slug}/acceso), sin depender del link del mail. El código viaja por WhatsApp con un
-- template de autenticación de Meta.
--
-- `customer_id` null = alta rápida pendiente: el DNI no existía y el cliente se crea recién
-- cuando el código se verifica, para no dejar fichas huérfanas.
-- `phone` es el destino del código. Puede ser un celular que todavía no está en `customers`:
-- se persiste en la ficha solo al verificar, así un celular no verificado nunca la toca.
-- Aplicar antes de desplegar el backend.
CREATE TABLE `customer_access_codes` (
  `id` varchar(36) NOT NULL,
  `customer_id` varchar(36) NULL,
  `event_id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `pending_name` varchar(255) NULL,
  `pending_dni` varchar(20) NULL,
  `phone` varchar(255) NOT NULL,
  `code_hash` varchar(64) NOT NULL,
  `attempts` int NOT NULL DEFAULT 0,
  `consumed_at` timestamp NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `customer_access_codes_id` PRIMARY KEY(`id`),
  CONSTRAINT `customer_access_codes_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`),
  CONSTRAINT `customer_access_codes_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
  CONSTRAINT `customer_access_codes_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`)
);
CREATE INDEX `customer_access_codes_customer_idx` ON `customer_access_codes` (`customer_id`,`event_id`);
CREATE INDEX `customer_access_codes_expires_idx` ON `customer_access_codes` (`expires_at`);
