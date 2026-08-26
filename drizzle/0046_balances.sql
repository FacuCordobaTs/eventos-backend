-- Tarea 6.1 — Saldo del cliente (visión §2.7): plata cargada dentro del evento, asociada a su
-- DNI. `customer_balances` es el saldo vigente por (cliente, evento) — único por par. Cada
-- movimiento queda en `balance_movements` (WEB = carga desde el celular acreditada por
-- MercadoPago/transferencia; CAJA = carga en efectivo/tarjeta en la caja física; REGALO = carga
-- de cortesía de la productora; CONSUMO = gasto al pagar con saldo). `payment_method` es el medio
-- de la carga (null en REGALO) y `sale_id` ata el movimiento a la venta que lo originó. Aditiva.
-- Además se extiende el enum de `sales.payment_method` con `SALDO` para las ventas pagadas con
-- saldo (ALTER a mano, no drizzle-kit push).
CREATE TABLE `customer_balances` (
	`id` varchar(36) NOT NULL,
	`customer_id` varchar(36) NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`amount` decimal(10,2) NOT NULL DEFAULT '0.00',
	`updated_at` timestamp ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `customer_balances_id` PRIMARY KEY(`id`),
	CONSTRAINT `customer_balances_customer_event_unique` UNIQUE(`customer_id`,`event_id`),
	CONSTRAINT `customer_balances_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `customer_balances_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `customer_balances_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action
);
CREATE INDEX `customer_balances_event_tenant_idx` ON `customer_balances` (`event_id`,`tenant_id`);
CREATE TABLE `balance_movements` (
	`id` varchar(36) NOT NULL,
	`customer_id` varchar(36) NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`type` enum('WEB','CAJA','REGALO','CONSUMO') NOT NULL,
	`payment_method` enum('CASH','CARD','MERCADOPAGO','TRANSFER','SALDO') NULL,
	`amount` decimal(10,2) NOT NULL,
	`staff_id` varchar(36) NULL,
	`sale_id` varchar(36) NULL,
	`note` varchar(255) NULL,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `balance_movements_id` PRIMARY KEY(`id`),
	CONSTRAINT `balance_movements_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `balance_movements_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `balance_movements_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `balance_movements_staff_id_staff_id_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `balance_movements_sale_id_sales_id_fk` FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON DELETE no action ON UPDATE no action
);
CREATE INDEX `balance_movements_customer_event_idx` ON `balance_movements` (`customer_id`,`event_id`);
CREATE INDEX `balance_movements_event_tenant_idx` ON `balance_movements` (`event_id`,`tenant_id`);
--> statement-breakpoint
ALTER TABLE `sales` MODIFY COLUMN `payment_method` enum('CASH','CARD','MERCADOPAGO','TRANSFER','SALDO') NOT NULL;
