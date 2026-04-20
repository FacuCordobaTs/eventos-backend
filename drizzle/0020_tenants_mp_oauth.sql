ALTER TABLE `tenants` ADD COLUMN `mp_access_token` varchar(512);--> statement-breakpoint
ALTER TABLE `tenants` ADD COLUMN `mp_refresh_token` varchar(512);--> statement-breakpoint
ALTER TABLE `tenants` ADD COLUMN `mp_public_key` varchar(255);--> statement-breakpoint
ALTER TABLE `tenants` ADD COLUMN `mp_user_id` varchar(255);--> statement-breakpoint
ALTER TABLE `tenants` ADD COLUMN `mp_connected` boolean DEFAULT false;
