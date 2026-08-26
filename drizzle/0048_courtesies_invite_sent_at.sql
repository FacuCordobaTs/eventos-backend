-- Tarea 7.3 — Envío de invitación por email + estado del envío (visión §2.2: "le llega por mail o
-- WhatsApp con un diseño de invitación").
-- Aditiva, no toca filas existentes:
--   `invite_sent_at` — timestamp de la última vez que se mandó la invitación por email (null =
--                      todavía no se envió). El panel muestra el estado del envío con esto.
ALTER TABLE `courtesies`
  ADD COLUMN `invite_sent_at` timestamp NULL;
