CREATE TABLE `account_pool` (
	`id` int AUTO_INCREMENT NOT NULL,
	`tenant_id` varchar(36),
	`account_number` varchar(255),
	`alias` varchar(255),
	`status` enum('available','assigned') DEFAULT 'available',
	`sale_id_assigned` varchar(36),
	`updated_at` timestamp DEFAULT (now()),
	CONSTRAINT `account_pool_id` PRIMARY KEY(`id`)
);
