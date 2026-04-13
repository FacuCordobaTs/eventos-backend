CREATE TABLE `event_expenses` (
	`id` varchar(36) NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`description` varchar(255) NOT NULL,
	`category` enum('MUSIC','LIGHTS','FOOD','STAFF','MARKETING','INFRASTRUCTURE','OTHER') NOT NULL DEFAULT 'OTHER',
	`amount` decimal(10,2) NOT NULL,
	`date` timestamp NOT NULL DEFAULT (now()),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `event_expenses_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `event_expenses` ADD CONSTRAINT `event_expenses_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `event_expenses` ADD CONSTRAINT `event_expenses_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `event_expenses_tenant_idx` ON `event_expenses` (`event_id`,`tenant_id`);