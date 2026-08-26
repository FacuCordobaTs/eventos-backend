-- Tarea 8.2 — Runner de jobs (visión §2.3): columna de idempotencia del recordatorio
-- de WhatsApp "1 h antes" de la puerta. El runner (`lib/jobs-runner.ts`) la setea tras
-- intentar el envío a los compradores del evento; al vivir en DB (no en memoria), un
-- restart del servicio nunca re-envía el recordatorio. Aditiva, no toca filas existentes.
ALTER TABLE `events`
  ADD COLUMN `whatsapp_reminder_sent_at` timestamp NULL;
