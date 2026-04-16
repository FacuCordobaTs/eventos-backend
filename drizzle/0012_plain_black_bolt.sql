-- Intencionalmente vacío: el contenido generado duplicaba 0009 (event_inventory),
-- 0010 (sales.bar_id) y 0011 (digital_consumptions.customer_id nullable).
-- Esas migraciones ya están en el journal; esta entrada solo mantiene el índice 12 alineado.
SELECT 1;
