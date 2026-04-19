ALTER TABLE `inventory_items` ADD COLUMN `default_content_value` decimal(10,2) NOT NULL DEFAULT '0.00';
--> statement-breakpoint
ALTER TABLE `inventory_items` ADD COLUMN `default_content_unit` enum('ML','GRAMOS','UNIDAD') NOT NULL DEFAULT 'ML';
--> statement-breakpoint
ALTER TABLE `products` ADD COLUMN `sale_type` enum('BOTTLE','GLASS') NOT NULL DEFAULT 'GLASS';
