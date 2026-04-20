ALTER TABLE `sales` MODIFY COLUMN `status` enum('PENDING','PAYMENT_FAILED','COMPLETED','REFUNDED') NOT NULL DEFAULT 'COMPLETED';--> statement-breakpoint
ALTER TABLE `sales` ADD COLUMN `guest_checkout_snapshot` json;--> statement-breakpoint
ALTER TABLE `sales` ADD COLUMN `mp_preference_id` varchar(64);--> statement-breakpoint
CREATE INDEX `sales_mp_preference_id_idx` ON `sales` (`mp_preference_id`);--> statement-breakpoint
CREATE TABLE `mp_processed_payments` (
	`payment_id` varchar(64) NOT NULL,
	`sale_id` varchar(36) NOT NULL,
	`processed_at` timestamp DEFAULT (now()),
	CONSTRAINT `mp_processed_payments_payment_id` PRIMARY KEY(`payment_id`)
);
