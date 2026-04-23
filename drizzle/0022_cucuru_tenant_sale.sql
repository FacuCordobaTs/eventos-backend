ALTER TABLE `tenants` ADD COLUMN `cucuru_api_key` varchar(255);--> statement-breakpoint
ALTER TABLE `tenants` ADD COLUMN `cucuru_collector_id` varchar(255);--> statement-breakpoint
ALTER TABLE `tenants` ADD COLUMN `cucuru_enabled` boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE `sales` ADD COLUMN `cucuru_alias` varchar(100);--> statement-breakpoint
ALTER TABLE `sales` ADD COLUMN `cucuru_cvu` varchar(22);--> statement-breakpoint
ALTER TABLE `sales` ADD COLUMN `cucuru_payment_id` varchar(100);
