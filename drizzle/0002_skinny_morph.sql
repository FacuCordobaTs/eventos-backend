ALTER TABLE `tickets` ADD `buyer_name` varchar(255);--> statement-breakpoint
ALTER TABLE `tickets` ADD `buyer_email` varchar(255);--> statement-breakpoint
CREATE INDEX `events_tenant_id_idx` ON `events` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `ticket_types_tenant_id_idx` ON `ticket_types` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `ticket_types_event_tenant_idx` ON `ticket_types` (`event_id`,`tenant_id`);--> statement-breakpoint
CREATE INDEX `tickets_tenant_id_idx` ON `tickets` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `tickets_event_tenant_idx` ON `tickets` (`event_id`,`tenant_id`);