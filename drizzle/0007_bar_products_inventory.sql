CREATE TABLE `bar_inventory` (
	`id` varchar(36) NOT NULL,
	`bar_id` varchar(36) NOT NULL,
	`inventory_item_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`current_stock` decimal(10,2) NOT NULL DEFAULT '0',
	`updated_at` timestamp ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bar_inventory_id` PRIMARY KEY(`id`),
	CONSTRAINT `bar_inventory_bar_item_unique` UNIQUE(`bar_id`,`inventory_item_id`)
);
--> statement-breakpoint
CREATE TABLE `bar_products` (
	`id` varchar(36) NOT NULL,
	`bar_id` varchar(36) NOT NULL,
	`product_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`is_active` boolean DEFAULT true,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `bar_products_id` PRIMARY KEY(`id`),
	CONSTRAINT `bar_products_bar_product_unique` UNIQUE(`bar_id`,`product_id`)
);
--> statement-breakpoint
ALTER TABLE `bar_inventory` ADD CONSTRAINT `bar_inventory_bar_id_bars_id_fk` FOREIGN KEY (`bar_id`) REFERENCES `bars`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bar_inventory` ADD CONSTRAINT `bar_inventory_inventory_item_id_inventory_items_id_fk` FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bar_inventory` ADD CONSTRAINT `bar_inventory_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bar_products` ADD CONSTRAINT `bar_products_bar_id_bars_id_fk` FOREIGN KEY (`bar_id`) REFERENCES `bars`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bar_products` ADD CONSTRAINT `bar_products_product_id_products_id_fk` FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bar_products` ADD CONSTRAINT `bar_products_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `bar_inventory_tenant_idx` ON `bar_inventory` (`bar_id`,`tenant_id`);--> statement-breakpoint
CREATE INDEX `bar_products_tenant_idx` ON `bar_products` (`bar_id`,`tenant_id`);