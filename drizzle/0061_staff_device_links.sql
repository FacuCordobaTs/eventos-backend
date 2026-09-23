-- Vinculación de un equipo por QR (estilo WhatsApp Web): la computadora muestra un código, un
-- teléfono que ya tiene sesión staff lo aprueba y la computadora recibe la sesión de esa persona.
--
-- `code` es público: viaja en el QR y sólo permite aprobar desde una sesión staff ya iniciada.
-- `secret` queda únicamente en el equipo que creó el vínculo y es lo que habilita reclamar el JWT;
-- así una foto del QR no alcanza para quedarse con la sesión. De un solo uso (`claimed_at`) y de
-- vida corta (`expires_at`), igual que los otros tokens de acceso del repo.
-- `requested_access` sólo guía la UI del teléfono: la sesión entregada es la del staff que aprueba.
-- Aplicar antes de desplegar el backend.
CREATE TABLE `staff_device_links` (
  `id` varchar(36) NOT NULL,
  `code` varchar(64) NOT NULL,
  `secret` varchar(64) NOT NULL,
  `requested_access` enum('pos','security') NULL,
  `staff_id` varchar(36) NULL,
  `approved_at` timestamp NULL,
  `claimed_at` timestamp NULL,
  `expires_at` timestamp NOT NULL,
  `created_at` timestamp DEFAULT (now()),
  CONSTRAINT `staff_device_links_id` PRIMARY KEY(`id`),
  CONSTRAINT `staff_device_links_code_unique` UNIQUE(`code`),
  CONSTRAINT `staff_device_links_staff_id_staff_id_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`)
);
CREATE INDEX `staff_device_links_expires_idx` ON `staff_device_links` (`expires_at`);
