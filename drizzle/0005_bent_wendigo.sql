CREATE TABLE `folders` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `folders_slug_unique` ON `folders` (`slug`);--> statement-breakpoint
ALTER TABLE `videos` ADD `folder_id` integer REFERENCES folders(id);