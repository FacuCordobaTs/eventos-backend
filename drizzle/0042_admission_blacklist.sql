-- Tarea 1.2 — Blacklist / registro de admisión.
-- "Si está en la lista de gente que no puede entrar, avisa con el motivo y la foto" (visión §2.4).
-- Keyed por DNI (la identidad en puerta): `POST /tickets/validate` rechaza con motivo + foto
-- cuando el `buyer_dni` del ticket tiene una entrada ACTIVA. La foto se sube a R2 (`photo_url`).
-- Un DNI puede tener varias filas (motivos distintos) — el chequeo usa cualquier fila activa.
CREATE TABLE `admission_blacklist` (
  `id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `dni` varchar(20) NOT NULL,
  `full_name` varchar(255) NULL,
  `photo_url` varchar(512) NULL,
  `reason` varchar(512) NOT NULL,
  `is_active` boolean NOT NULL DEFAULT TRUE,
  `created_by` varchar(36) NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `admission_blacklist_event_tenant_idx` (`event_id`, `tenant_id`),
  KEY `admission_blacklist_event_dni_idx` (`event_id`, `dni`)
);
