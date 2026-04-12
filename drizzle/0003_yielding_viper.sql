CREATE TABLE `customers` (
	`id` varchar(36) NOT NULL,
	`name` varchar(255) NOT NULL,
	`email` varchar(255) NOT NULL,
	`password_hash` varchar(255),
	`phone` varchar(50),
	`is_active` boolean DEFAULT true,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `customers_id` PRIMARY KEY(`id`),
	CONSTRAINT `customers_email_unique` UNIQUE(`email`)
);
--> statement-breakpoint
CREATE TABLE `digital_consumptions` (
	`id` varchar(36) NOT NULL,
	`customer_id` varchar(36) NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`product_id` varchar(36) NOT NULL,
	`sale_id` varchar(36) NOT NULL,
	`qr_hash` varchar(255) NOT NULL,
	`status` enum('PENDING','REDEEMED','CANCELLED') DEFAULT 'PENDING',
	`redeemed_at` timestamp,
	`redeemed_by` varchar(36),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `digital_consumptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `digital_consumptions_qr_hash_unique` UNIQUE(`qr_hash`)
);
--> statement-breakpoint
ALTER TABLE `sales` ADD `customer_id` varchar(36);--> statement-breakpoint
ALTER TABLE `sales` ADD `source` enum('POS','APP','WEB') DEFAULT 'POS' NOT NULL;--> statement-breakpoint
ALTER TABLE `tickets` ADD `customer_id` varchar(36);--> statement-breakpoint
ALTER TABLE `digital_consumptions` ADD CONSTRAINT `digital_consumptions_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `digital_consumptions` ADD CONSTRAINT `digital_consumptions_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `digital_consumptions` ADD CONSTRAINT `digital_consumptions_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `digital_consumptions` ADD CONSTRAINT `digital_consumptions_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `digital_consumptions` ADD CONSTRAINT `digital_consumptions_sale_id_sales_id_fk` FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `digital_consumptions` ADD CONSTRAINT `digital_consumptions_redeemed_by_staff_id_fk` FOREIGN KEY (`redeemed_by`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tickets` ADD CONSTRAINT `tickets_customer_id_customers_id_fk` FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `tickets_customer_id_idx` ON `tickets` (`customer_id`);