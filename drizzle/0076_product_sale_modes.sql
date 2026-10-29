-- Modos de venta por producto (Trago / Botellas / Unidad / Sin control) e insumos
-- contados siempre en unidades. Aplicar una sola vez, antes de desplegar el backend.
-- El orden importa: las conversiones leen base_unit/package_size antes de normalizarlos.

-- 1. Stock y recetas con fracciones finas: un trago descuenta 1/N unidades.
ALTER TABLE `product_recipes` MODIFY COLUMN `quantity_used` decimal(16,6) NOT NULL;
ALTER TABLE `bar_inventory` MODIFY COLUMN `current_stock` decimal(16,6) NOT NULL DEFAULT '0';
ALTER TABLE `event_inventory` MODIFY COLUMN `stock_allocated` decimal(16,6) NOT NULL DEFAULT '0';

-- 2. Orden por creación reciente en los listados de insumos.
ALTER TABLE `inventory_items` ADD COLUMN `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP;

-- 3. Nuevos modos de venta.
ALTER TABLE `products`
  MODIFY COLUMN `sale_type` enum('BOTTLE','GLASS','UNIT','NONE') NOT NULL DEFAULT 'GLASS';

-- 4. Recetas de trago: ml/g por porción -> envases por porción. Se trunca (nunca se
--    redondea hacia arriba) para que la última porción de un envase no quede bloqueada.
--    Las recetas BOTTLE ya guardan envases enteros.
UPDATE `product_recipes` r
JOIN `products` p ON p.id = r.product_id
JOIN `inventory_items` i ON i.id = r.inventory_item_id
SET r.quantity_used = TRUNCATE(r.quantity_used / i.package_size, 6)
WHERE p.sale_type = 'GLASS'
  AND i.base_unit IN ('ML', 'GRAMS')
  AND i.package_size > 0;

-- 5. Existencias en ml/g -> envases. purchases.quantity ya se guarda en envases.
UPDATE `bar_inventory` bi
JOIN `inventory_items` i ON i.id = bi.inventory_item_id
SET bi.current_stock = TRUNCATE(bi.current_stock / i.package_size, 6)
WHERE i.base_unit IN ('ML', 'GRAMS') AND i.package_size > 0;

UPDATE `event_inventory` ei
JOIN `inventory_items` i ON i.id = ei.inventory_item_id
SET ei.stock_allocated = TRUNCATE(ei.stock_allocated / i.package_size, 6)
WHERE i.base_unit IN ('ML', 'GRAMS') AND i.package_size > 0;

-- 6. N ("ventas que terminan una unidad") para tragos; las botellas no lo usan.
UPDATE `product_recipes` r
JOIN `products` p ON p.id = r.product_id
SET r.yield_per_package = CASE
  WHEN p.sale_type = 'GLASS' AND r.quantity_used > 0 THEN TRUNCATE(1 / r.quantity_used, 3)
  ELSE NULL
END;

-- 7. Insumos: sólo nombre, contados en unidades.
UPDATE `inventory_items`
SET `base_unit` = 'UNIT', `package_size` = 1, `counting_unit` = 'unidades';

-- 8. Productos sin receta: UNIT si alguna barra lleva su conteo, si no NONE.
UPDATE `products` p
SET p.sale_type = CASE
  WHEN EXISTS (
    SELECT 1 FROM `bar_products` bp
    WHERE bp.product_id = p.id AND bp.tenant_id = p.tenant_id AND bp.direct_stock IS NOT NULL
  ) THEN 'UNIT'
  ELSE 'NONE'
END
WHERE NOT EXISTS (SELECT 1 FROM `product_recipes` r WHERE r.product_id = p.id);

-- Un producto UNIT siempre tiene conteo en cada barra donde se vende (0 si no había).
UPDATE `bar_products` bp
JOIN `products` p ON p.id = bp.product_id AND p.tenant_id = bp.tenant_id
SET bp.direct_stock = 0
WHERE p.sale_type = 'UNIT' AND bp.direct_stock IS NULL;
