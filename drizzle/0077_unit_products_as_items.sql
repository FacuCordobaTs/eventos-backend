-- Los productos que se venden por unidad pasan a ser insumos: cada uno descuenta 1 unidad de
-- un insumo propio (mismo nombre), que otros productos pueden usar en sus recetas.
-- Las existencias por barra (bar_products.direct_stock) se trasladan a ese insumo.
-- Aplicar una sola vez, después de 0076 y antes de desplegar el backend.

-- 1. Insumo propio para cada producto por unidad sin receta (reutiliza uno activo del mismo nombre).
INSERT INTO `inventory_items` (`id`, `tenant_id`, `name`, `base_unit`, `package_size`, `counting_unit`, `is_active`, `created_at`)
SELECT UUID(), src.tenant_id, src.name, 'UNIT', 1, 'unidades', true, CURRENT_TIMESTAMP
FROM (
  SELECT p.tenant_id, MIN(TRIM(p.name)) AS name
  FROM `products` p
  WHERE p.sale_type = 'UNIT'
    AND NOT EXISTS (SELECT 1 FROM `product_recipes` r WHERE r.product_id = p.id)
    AND NOT EXISTS (
      SELECT 1 FROM `inventory_items` i
      WHERE i.tenant_id = p.tenant_id AND i.is_active = true AND LOWER(TRIM(i.name)) = LOWER(TRIM(p.name))
    )
  GROUP BY p.tenant_id, LOWER(TRIM(p.name))
) src;

-- 2. Receta de una línea: 1 unidad del insumo propio por venta.
INSERT INTO `product_recipes` (`id`, `product_id`, `inventory_item_id`, `quantity_used`, `yield_per_package`)
SELECT UUID(), p.id, (
  SELECT MIN(i.id) FROM `inventory_items` i
  WHERE i.tenant_id = p.tenant_id AND i.is_active = true AND LOWER(TRIM(i.name)) = LOWER(TRIM(p.name))
), 1, NULL
FROM `products` p
WHERE p.sale_type = 'UNIT'
  AND NOT EXISTS (SELECT 1 FROM `product_recipes` r WHERE r.product_id = p.id);

-- 3. Conteo por barra -> stock del insumo en esa barra.
INSERT INTO `bar_inventory` (`id`, `bar_id`, `inventory_item_id`, `tenant_id`, `current_stock`)
SELECT UUID(), bp.bar_id, r.inventory_item_id, bp.tenant_id, SUM(bp.direct_stock)
FROM `bar_products` bp
JOIN `products` p ON p.id = bp.product_id AND p.tenant_id = bp.tenant_id
JOIN `product_recipes` r ON r.product_id = p.id
WHERE p.sale_type = 'UNIT' AND bp.direct_stock IS NOT NULL
GROUP BY bp.bar_id, r.inventory_item_id, bp.tenant_id
ON DUPLICATE KEY UPDATE `current_stock` = `bar_inventory`.`current_stock` + VALUES(`current_stock`);

-- 4. El agregado del evento acompaña lo que se sumó en sus barras.
INSERT INTO `event_inventory` (`id`, `event_id`, `inventory_item_id`, `tenant_id`, `stock_allocated`)
SELECT UUID(), b.event_id, r.inventory_item_id, bp.tenant_id, SUM(bp.direct_stock)
FROM `bar_products` bp
JOIN `bars` b ON b.id = bp.bar_id AND b.tenant_id = bp.tenant_id
JOIN `products` p ON p.id = bp.product_id AND p.tenant_id = bp.tenant_id
JOIN `product_recipes` r ON r.product_id = p.id
WHERE p.sale_type = 'UNIT' AND bp.direct_stock IS NOT NULL
GROUP BY b.event_id, r.inventory_item_id, bp.tenant_id
ON DUPLICATE KEY UPDATE `stock_allocated` = `event_inventory`.`stock_allocated` + VALUES(`stock_allocated`);

-- 5. Ningún modo usa ya el conteo por barra del producto.
UPDATE `bar_products` SET `direct_stock` = NULL WHERE `direct_stock` IS NOT NULL;
