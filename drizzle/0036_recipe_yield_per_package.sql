-- Tarea 1.5 — Rendimiento "N por envase" en product_recipes.
-- Aditiva: agrega yield_per_package (cuántas porciones salen de un envase contable del insumo)
-- y backfillea desde el modelo viejo (quantity_used en base units + package_size del insumo).
-- No toca quantity_used: sigue vivo para la deducción de stock hasta que la Barra (3.2) mueva el
-- stock a unidad contable. Mismo patrón SQL-a-mano de 0032–0035 (no toca _journal.json / meta).

ALTER TABLE `product_recipes`
  ADD COLUMN `yield_per_package` decimal(10,3) NULL;

-- Backfill: yield = porciones por envase.
--   base_unit = 'UNIT'  -> 1 / quantity_used            (quantity_used = envases por porción)
--   package_size > 0    -> package_size / quantity_used  (ml o g por envase / ml o g por porción)
--   resto               -> 1 / quantity_used             (sin envase fijo)
UPDATE `product_recipes` pr
JOIN `inventory_items` ii ON ii.id = pr.inventory_item_id
SET pr.yield_per_package = CASE
  WHEN pr.quantity_used <= 0 THEN NULL
  WHEN ii.base_unit = 'UNIT' THEN 1 / pr.quantity_used
  WHEN ii.package_size > 0 THEN ii.package_size / pr.quantity_used
  ELSE 1 / pr.quantity_used
END;
