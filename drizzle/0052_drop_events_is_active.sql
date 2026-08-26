-- Tarea 11.3 — Retiro de `events.is_active` (deuda del modelo viejo). La visibilidad del evento
-- vive en `events.status` (draft → on_sale → live → closed): el viejo sync de la transición hacía
-- `is_active = (status != 'closed')` y todos los filtros de lectura ya usan `status`. No hay
-- índices ni FKs sobre la columna. Aplicar junto con el deploy que deja de leerla.
ALTER TABLE `events` DROP COLUMN `is_active`;
