-- Tarea 4.4 — Ceremonia de cierre: liquidación congelada del evento.
-- Snapshot JSON con el conteo real de insumos, la estimación del sistema, el costo de mercadería
-- consumida (no comprada), el sobrante valuado, la caja, los ingresos, gastos, neto y merma.
-- Se persiste porque el conteo manual no se puede rederivar después del cierre.
ALTER TABLE `events` ADD COLUMN `closing_report` json;
