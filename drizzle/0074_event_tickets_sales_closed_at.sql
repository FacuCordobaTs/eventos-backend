-- Cierre de venta de entradas por evento. NULL = sin cierre. Aplicar antes de desplegar el backend.
ALTER TABLE `events`
  ADD COLUMN `tickets_sales_closed_at` timestamp NULL DEFAULT NULL;
