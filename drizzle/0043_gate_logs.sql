-- Tarea 1.3 — Reingreso y gate log (visión §2.4: "Si ya entró con esa entrada, avisa").
-- 1) `events.allow_reentry`: si está activado, `POST /tickets/validate` deja re-validar un
--    ticket USED: registra otro pase IN en `gate_logs` y la respuesta avisa `reentry: true`.
--    Default FALSE: una entrada entra una sola vez (un ticket USED sigue dando 409).
ALTER TABLE `events` ADD COLUMN `allow_reentry` boolean NOT NULL DEFAULT FALSE;

-- 2) `gate_logs`: cada pase de puerta (IN/OUT) de una entrada. No altera el estado del ticket:
--    es el registro de quién pasó y cuándo, para el reingreso y el conteo de gente.
--    `tenant_id` incluido para el aislamiento lógico por productora (los lookups van scoped
--    por ticket, que ya lo tiene).
CREATE TABLE `gate_logs` (
  `id` varchar(36) NOT NULL,
  `ticket_id` varchar(36) NOT NULL,
  `event_id` varchar(36) NOT NULL,
  `tenant_id` varchar(36) NOT NULL,
  `action` enum('IN','OUT') NOT NULL,
  `scanned_by` varchar(36) NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `gate_logs_ticket_idx` (`ticket_id`),
  KEY `gate_logs_event_tenant_idx` (`event_id`, `tenant_id`)
);
