-- Stock por unidad propio de cada barra. No modifica recetas ni stock de insumos.
ALTER TABLE `bar_products` ADD COLUMN `direct_stock` decimal(10,2) NULL;

-- El límite histórico del evento se conserva UNA sola vez: barra general activa,
-- o primera barra activa por fecha/id. Las otras barras del mismo producto arrancan
-- en cero; no se multiplica el total que había. Revisar los conteos físicos al abrir.
-- event_products.direct_stock se conserva como dato histórico/compatibilidad.
UPDATE `bar_products` bp
JOIN `bars` b ON b.id = bp.bar_id AND b.tenant_id = bp.tenant_id
JOIN `event_products` ep ON ep.event_id = b.event_id
  AND ep.product_id = bp.product_id AND ep.tenant_id = bp.tenant_id
SET bp.direct_stock = CASE WHEN EXISTS (
  SELECT 1 FROM `bars` earlier
  JOIN (SELECT bar_id, product_id, tenant_id, is_active FROM `bar_products` GROUP BY bar_id, product_id, tenant_id, is_active) candidate
    ON candidate.bar_id = earlier.id AND candidate.tenant_id = earlier.tenant_id
  WHERE earlier.event_id = b.event_id AND earlier.tenant_id = b.tenant_id
    AND candidate.product_id = bp.product_id
    AND (
      COALESCE(earlier.is_active, 1) > COALESCE(b.is_active, 1)
      OR (COALESCE(earlier.is_active, 1) = COALESCE(b.is_active, 1) AND earlier.is_default > b.is_default)
      OR (COALESCE(earlier.is_active, 1) = COALESCE(b.is_active, 1) AND earlier.is_default = b.is_default
        AND (COALESCE(earlier.created_at, '1970-01-01') < COALESCE(b.created_at, '1970-01-01')
          OR (COALESCE(earlier.created_at, '1970-01-01') = COALESCE(b.created_at, '1970-01-01') AND earlier.id < b.id)))
    )
) THEN 0 ELSE ep.direct_stock END
WHERE ep.direct_stock IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM `product_recipes` r WHERE r.product_id = bp.product_id);
