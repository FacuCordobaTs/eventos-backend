-- Tarea 1.1 — Identidad del cliente: DNI y fecha de nacimiento.
-- El DNI es la identidad del cliente dentro del evento (visión §2.0): puerta, caja y saldo
-- cuelgan de él. `customers.dni` es único GLOBAL (un cliente es una persona) pero nullable:
-- los clientes pre-existentes no tienen DNI (MySQL permite múltiples NULLs en un unique key).
-- `tickets.buyer_dni` es un snapshot al emitir la entrada, para lookup en puerta sin join.
ALTER TABLE `customers` ADD COLUMN `dni` varchar(20) NULL;
ALTER TABLE `customers` ADD UNIQUE KEY `customers_dni_unique` (`dni`);
ALTER TABLE `customers` ADD COLUMN `birth_date` timestamp NULL;
ALTER TABLE `tickets` ADD COLUMN `buyer_dni` varchar(20) NULL;
ALTER TABLE `tickets` ADD INDEX `tickets_event_buyer_dni_idx` (`event_id`, `buyer_dni`);
