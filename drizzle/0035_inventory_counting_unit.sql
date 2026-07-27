-- Tarea 1.4: unidad contable en inventory_items.
-- Agrega `counting_unit` (la unidad que el usuario ya sabe: botella/lata/bolsa) y backfillea
-- una etiqueta razonable desde el modelo viejo (base_unit + package_size), que queda deprecado
-- pero vivo por back-compat con recetas/deducciones existentes.
ALTER TABLE `inventory_items` ADD COLUMN `counting_unit` varchar(50) NOT NULL DEFAULT 'unidad';

UPDATE `inventory_items`
SET `counting_unit` = CASE
  WHEN `base_unit` = 'UNIT' THEN 'unidad'
  WHEN `package_size` > 0 THEN 'botella'
  WHEN `base_unit` = 'ML' THEN 'ml'
  WHEN `base_unit` = 'GRAMS' THEN 'g'
  ELSE 'unidad'
END;
