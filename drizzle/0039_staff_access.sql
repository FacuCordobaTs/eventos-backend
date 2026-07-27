-- Staff sin fricción (spec §1, tarea 1.8): invitaciones por link/QR, magic link de login
-- y sesión de puesto (dispositivo fijado a una barra, rotación por PIN).
-- Aditiva: tres tablas nuevas, no toca `staff` ni datos existentes. El alta por PIN se hace
-- creando filas en `staff` con email sintético + hash random (no se cambia el schema de staff).

-- Invitación de staff: link nominado a un rol dentro del tenant. Al aceptarse crea el staff
-- (nombre + PIN) y queda enlazada por `accepted_staff_id`.
CREATE TABLE `staff_invitations` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `role` enum('ADMIN','MANAGER','BARTENDER','SECURITY') NOT NULL,
  `token` varchar(64) NOT NULL,
  `status` enum('PENDING','ACCEPTED','REVOKED') NOT NULL DEFAULT 'PENDING',
  `accepted_staff_id` varchar(36) NULL,
  `accepted_at` timestamp NULL,
  `expires_at` timestamp NULL,
  `created_by` varchar(36) NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `staff_invitations_id` PRIMARY KEY(`id`),
  CONSTRAINT `staff_invitations_token_unique` UNIQUE(`token`),
  CONSTRAINT `staff_invitations_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
  CONSTRAINT `staff_invitations_accepted_staff_id_staff_id_fk` FOREIGN KEY (`accepted_staff_id`) REFERENCES `staff`(`id`),
  CONSTRAINT `staff_invitations_created_by_staff_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`)
);
CREATE INDEX `staff_invitations_tenant_id_idx` ON `staff_invitations` (`tenant_id`);
CREATE INDEX `staff_invitations_status_idx` ON `staff_invitations` (`tenant_id`,`status`);

-- Magic link de login ("Recibir un enlace de acceso"). Keyed por email, un solo uso, vida corta.
CREATE TABLE `magic_links` (
  `id` varchar(36) NOT NULL,
  `email` varchar(255) NOT NULL,
  `token` varchar(64) NOT NULL,
  `used_at` timestamp NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `magic_links_id` PRIMARY KEY(`id`),
  CONSTRAINT `magic_links_token_unique` UNIQUE(`token`)
);
CREATE INDEX `magic_links_email_idx` ON `magic_links` (`email`);

-- Sesión de puesto: dispositivo fijado a un evento y (opcionalmente) a una barra/puesto.
-- El personal rota sobre el dispositivo identificándose por PIN.
CREATE TABLE `pos_sessions` (
  `id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `bar_id` varchar(36) NULL,
  `token` varchar(64) NOT NULL,
  `label` varchar(255) NULL,
  `is_active` boolean NOT NULL DEFAULT true,
  `created_by` varchar(36) NULL,
  `last_used_at` timestamp NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `pos_sessions_id` PRIMARY KEY(`id`),
  CONSTRAINT `pos_sessions_token_unique` UNIQUE(`token`),
  CONSTRAINT `pos_sessions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`),
  CONSTRAINT `pos_sessions_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`),
  CONSTRAINT `pos_sessions_bar_id_bars_id_fk` FOREIGN KEY (`bar_id`) REFERENCES `bars`(`id`),
  CONSTRAINT `pos_sessions_created_by_staff_id_fk` FOREIGN KEY (`created_by`) REFERENCES `staff`(`id`)
);
CREATE INDEX `pos_sessions_tenant_id_idx` ON `pos_sessions` (`tenant_id`);
CREATE INDEX `pos_sessions_event_tenant_idx` ON `pos_sessions` (`event_id`,`tenant_id`);
