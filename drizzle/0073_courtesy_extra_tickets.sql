-- Cortesías sobre un tipo con promo (2x1): ids de las entradas adicionales emitidas al canjear.
-- NULL = una sola entrada (comportamiento anterior). Aplicar antes de desplegar el backend.
ALTER TABLE `courtesies`
  ADD COLUMN `extra_ticket_ids` json NULL DEFAULT NULL;
