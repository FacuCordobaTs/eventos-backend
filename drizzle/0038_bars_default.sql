-- Tarea 1.7: barra implícita.
-- Marca la barra "por defecto" del evento (la única que vende todo sin config).
-- Los puestos (subdivisión avanzada) quedan con is_default = 0.
-- Aditiva y no destructiva (mismo patrón SQL-a-mano de 0032–0037: no se toca
-- _journal.json/meta, que están stale — el deploy aplica con push o SQL manual).

ALTER TABLE `bars`
  ADD COLUMN `is_default` boolean NOT NULL DEFAULT false;

-- Backfill: por cada (event_id, tenant_id) la barra más vieja pasa a ser la default.
-- Los eventos sin barras quedan sin default; su barra implícita se materializa
-- on-demand cuando el productor divide en puestos (ensureDefaultBar).
UPDATE `bars` b
JOIN (
  SELECT `id`
  FROM (
    SELECT
      `id`,
      ROW_NUMBER() OVER (
        PARTITION BY `event_id`, `tenant_id`
        ORDER BY `created_at` ASC, `id` ASC
      ) AS rn
    FROM `bars`
  ) ranked
  WHERE rn = 1
) firsts ON firsts.`id` = b.`id`
SET b.`is_default` = true;
