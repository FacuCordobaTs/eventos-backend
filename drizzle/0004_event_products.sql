CREATE TABLE `event_products` (
	`id` varchar(36) NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`product_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`price_override` decimal(10,2),
	`is_active` boolean DEFAULT true,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `event_products_id` PRIMARY KEY(`id`),
	CONSTRAINT `event_products_event_product_unique` UNIQUE(`event_id`,`product_id`)
);
--> statement-breakpoint
ALTER TABLE `event_products` ADD CONSTRAINT `event_products_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `event_products` ADD CONSTRAINT `event_products_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `event_products` ADD CONSTRAINT `event_products_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `event_products_event_tenant_idx` ON `event_products` (`event_id`,`tenant_id`);