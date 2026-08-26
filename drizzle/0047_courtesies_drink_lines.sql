-- Tarea 7.1 — Cortesías con tragos de regalo (visión §2.2: "con tragos de regalo si se quiere").
-- Aditiva, no toca filas existentes:
--   `drink_lines`  — json [{productId, quantity}] de tragos que la invitación regala; null = como hoy.
--   `drink_sale_id` — sale de $0 (source WEB, sin sale_items) que ancla las digital_consumptions
--                     emitidas al canjear. `digital_consumptions.sale_id` es NOT NULL y el canje
--                     1×1 en barra (`POST /bars/:barId/redeem`) la joinnea contra `sales`, así que
--                     los tragos de regalo se cuelgan de una sale real de $0 en vez de volver
--                     nullable la FK. La sale de $0 no ensucia la recaudación: el cierre suma
--                     sale_items × precio y el total CASH (cero en ambos).
ALTER TABLE `courtesies`
  ADD COLUMN `drink_lines` json NULL,
  ADD COLUMN `drink_sale_id` varchar(36) NULL,
  ADD CONSTRAINT `courtesies_drink_sale_id_sales_id_fk`
    FOREIGN KEY (`drink_sale_id`) REFERENCES `sales`(`id`);
