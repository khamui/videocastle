ALTER TABLE `videos` ADD `source_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `rendition_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `videos` ADD `poster_bytes` integer DEFAULT 0 NOT NULL;