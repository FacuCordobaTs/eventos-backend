-- Promo "llevás X, pagás Y" por tipo de entrada (2x1 = 2/1). NULL/NULL = sin promo.
-- Aplicar antes de desplegar el backend.
ALTER TABLE `ticket_types`
  ADD COLUMN `promo_buy` int NULL DEFAULT NULL,
  ADD COLUMN `promo_pay` int NULL DEFAULT NULL;
