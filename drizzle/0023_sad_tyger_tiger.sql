CREATE TABLE `account_pool` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` varchar(36),
	`account_number` varchar(255),
	`alias` varchar(255),
	`status` enum('available','assigned') DEFAULT 'available',
	`sale_id_assigned` varchar(36),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `account_pool_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `mp_processed_payments` (
	`payment_id` varchar(64) NOT NULL,
	`sale_id` varchar(36) NOT NULL,
	`processed_at` timestamp DEFAULT (now()),
	CONSTRAINT `mp_processed_payments_payment_id` PRIMARY KEY(`payment_id`)
);
--> statement-breakpoint
ALTER TABLE `sales` MODIFY COLUMN `status` enum('PENDING','PAYMENT_FAILED','COMPLETED','REFUNDED') DEFAULT 'COMPLETED';--> statement-breakpoint
ALTER TABLE `events` ADD `image_url` varchar(512);--> statement-breakpoint
ALTER TABLE `inventory_items` ADD `base_unit` enum('ML','GRAMS','UNIT') NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_items` ADD `package_size` decimal(10,2) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE `inventory_items` ADD `is_active` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sales` ADD `guest_checkout_snapshot` json;--> statement-breakpoint
ALTER TABLE `sales` ADD `mp_preference_id` varchar(64);--> statement-breakpoint
ALTER TABLE `sales` ADD `cucuru_alias` varchar(100);--> statement-breakpoint
ALTER TABLE `sales` ADD `cucuru_cvu` varchar(22);--> statement-breakpoint
ALTER TABLE `sales` ADD `cucuru_payment_id` varchar(100);--> statement-breakpoint
ALTER TABLE `sales` ADD `paid` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `sales` ADD `paid_at` timestamp;--> statement-breakpoint
ALTER TABLE `tenants` ADD `mp_access_token` varchar(512);--> statement-breakpoint
ALTER TABLE `tenants` ADD `mp_refresh_token` varchar(512);--> statement-breakpoint
ALTER TABLE `tenants` ADD `mp_public_key` varchar(255);--> statement-breakpoint
ALTER TABLE `tenants` ADD `mp_user_id` varchar(255);--> statement-breakpoint
ALTER TABLE `tenants` ADD `mp_connected` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `tenants` ADD `cucuru_api_key` varchar(255);--> statement-breakpoint
ALTER TABLE `tenants` ADD `cucuru_collector_id` varchar(255);--> statement-breakpoint
ALTER TABLE `tenants` ADD `cucuru_enabled` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `account_pool` ADD CONSTRAINT `account_pool_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sales_mp_preference_id_idx` ON `sales` (`mp_preference_id`);--> statement-breakpoint
ALTER TABLE `inventory_items` DROP COLUMN `unit`;--> statement-breakpoint
ALTER TABLE `inventory_items` DROP COLUMN `default_content_value`;--> statement-breakpoint
ALTER TABLE `inventory_items` DROP COLUMN `default_content_unit`;