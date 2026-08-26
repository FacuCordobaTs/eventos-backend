-- Tarea 8.1 — Proveedor de WhatsApp (visión §2.3): la productora conecta su número de
-- WhatsApp Business vía Meta Cloud API. Aditiva, no toca filas existentes:
--   `whatsapp_phone`            — número de WhatsApp Business (normalizado, ej. 5491155555555)
--   `whatsapp_phone_number_id`  — ID del número en Meta (va en la URL de la Graph API)
--   `whatsapp_token`            — System User Access Token de Meta
--   `whatsapp_template_name`    — template aprobado para el recordatorio (tarea 8.2); null = default
--   `whatsapp_enabled`          — si la conexión está activa (se prende al conectar con validación ok)
ALTER TABLE `tenants`
  ADD COLUMN `whatsapp_phone` varchar(32) NULL,
  ADD COLUMN `whatsapp_phone_number_id` varchar(64) NULL,
  ADD COLUMN `whatsapp_token` varchar(512) NULL,
  ADD COLUMN `whatsapp_template_name` varchar(64) NULL,
  ADD COLUMN `whatsapp_enabled` boolean NOT NULL DEFAULT FALSE;
