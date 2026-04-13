CREATE TABLE `event_staff` (
	`id` varchar(36) NOT NULL,
	`event_id` varchar(36) NOT NULL,
	`tenant_id` varchar(36) NOT NULL,
	`staff_id` varchar(36) NOT NULL,
	`bar_id` varchar(36),
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `event_staff_id` PRIMARY KEY(`id`),
	CONSTRAINT `event_staff_event_staff_unique` UNIQUE(`event_id`,`staff_id`)
);
--> statement-breakpoint
ALTER TABLE `event_staff` ADD CONSTRAINT `event_staff_event_id_events_id_fk` FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `event_staff` ADD CONSTRAINT `event_staff_tenant_id_tenants_id_fk` FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `event_staff` ADD CONSTRAINT `event_staff_staff_id_staff_id_fk` FOREIGN KEY (`staff_id`) REFERENCES `staff`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `event_staff` ADD CONSTRAINT `event_staff_bar_id_bars_id_fk` FOREIGN KEY (`bar_id`) REFERENCES `bars`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `event_staff_event_tenant_idx` ON `event_staff` (`event_id`,`tenant_id`);