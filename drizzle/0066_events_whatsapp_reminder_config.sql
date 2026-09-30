-- Configuración por evento del recordatorio de WhatsApp (pantalla "Mensajes" de la sección Entradas
-- del admin): un interruptor y cuánto antes de la hora del evento sale el mensaje. El runner
-- (`lib/jobs-runner.ts`) los lee; `whatsapp_reminder_sent_at` (0050) sigue siendo la marca de "ya salió".
--
-- El interruptor arranca APAGADO en todos los eventos, los existentes incluidos: el recordatorio sólo
-- sale si un administrador lo activa. El adelanto arranca en 60 minutos. La hora de referencia es
-- `doors_at` y, si no está cargada, `date`.
-- Aditiva: no toca filas existentes. Aplicar antes de desplegar el backend.
ALTER TABLE `events`
  ADD COLUMN `whatsapp_reminder_enabled` boolean NOT NULL DEFAULT FALSE,
  ADD COLUMN `whatsapp_reminder_lead_minutes` int NOT NULL DEFAULT 60;
