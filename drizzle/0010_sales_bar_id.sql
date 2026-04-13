ALTER TABLE `sales` ADD `bar_id` varchar(36);--> statement-breakpoint
ALTER TABLE `sales` ADD CONSTRAINT `sales_bar_id_bars_id_fk` FOREIGN KEY (`bar_id`) REFERENCES `bars`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `sales_bar_id_idx` ON `sales` (`bar_id`);
