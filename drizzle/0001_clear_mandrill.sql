ALTER TABLE `staff` ADD `is_active` boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX `staff_tenant_id_idx` ON `staff` (`tenant_id`);