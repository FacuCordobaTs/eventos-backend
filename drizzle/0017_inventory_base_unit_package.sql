ALTER TABLE `inventory_items` ADD COLUMN `base_unit` enum('ML','GRAMS','UNIT') NOT NULL DEFAULT 'ML';
--> statement-breakpoint
ALTER TABLE `inventory_items` ADD COLUMN `package_size` decimal(10,2) NOT NULL DEFAULT '0.00';
--> statement-breakpoint
UPDATE `inventory_items` SET
  `base_unit` = CASE `unit`
    WHEN 'GRAMOS' THEN 'GRAMS'
    WHEN 'UNIDAD' THEN 'UNIT'
    ELSE 'ML'
  END,
  `package_size` = `default_content_value`;
--> statement-breakpoint
ALTER TABLE `inventory_items` DROP COLUMN `unit`;
--> statement-breakpoint
ALTER TABLE `inventory_items` DROP COLUMN `default_content_value`;
--> statement-breakpoint
ALTER TABLE `inventory_items` DROP COLUMN `default_content_unit`;
