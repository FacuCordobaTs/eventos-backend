ALTER TABLE `customers` DROP COLUMN `password_hash`;
--> statement-breakpoint
ALTER TABLE `customers` MODIFY COLUMN `phone` varchar(255);
--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `tickets_available_from` timestamp;
--> statement-breakpoint
ALTER TABLE `events` ADD COLUMN `consumptions_available_from` timestamp;
--> statement-breakpoint
ALTER TABLE `sales` ADD COLUMN `receipt_token` varchar(36);
--> statement-breakpoint
UPDATE `sales` SET `receipt_token` = UUID() WHERE `receipt_token` IS NULL;
--> statement-breakpoint
ALTER TABLE `sales` MODIFY COLUMN `receipt_token` varchar(36) NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_receipt_token_unique` ON `sales` (`receipt_token`);
--> statement-breakpoint
ALTER TABLE `tickets` ADD COLUMN `sale_id` varchar(36);
--> statement-breakpoint
CREATE INDEX `tickets_sale_id_idx` ON `tickets` (`sale_id`);
