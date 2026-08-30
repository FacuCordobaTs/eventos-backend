ALTER TABLE `events` ADD `venue` varchar(255);
--> statement-breakpoint
UPDATE `events` SET `venue` = `location` WHERE `venue` IS NULL AND `location` IS NOT NULL;
