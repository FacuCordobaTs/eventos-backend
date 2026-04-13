CREATE TABLE `event_inventory` (
	`id` varchar(36) NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`inventory_item_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`stock_allocated` decimal(10,2) NOT NULL DEFAULT '0',
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `event_inventory_id` PRIMARY KEY(`id`),
	CONSTRAINT `event_inventory_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `event_inventory_inventory_item_id_inventory_items_id_fk` FOREIGN KEY (`inventory_item_id`) REFERENCES `inventory_items`(`id`) ON DELETE no action ON UPDATE no action,
	CONSTRAINT `event_inventory_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_inventory_event_item_unique` ON `event_inventory` (`event_id`,`inventory_item_id`);--> statement-breakpoint
CREATE INDEX `event_inventory_tenant_idx` ON `event_inventory` (`tenant_id`);--> statement-breakpoint
ALTER TABLE `inventory_items` DROP COLUMN `current_stock`;
