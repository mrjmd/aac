ALTER TABLE `content_posts` ADD `source_type` text DEFAULT 'ai-full' NOT NULL;--> statement-breakpoint
ALTER TABLE `content_posts` ADD `template_id` text;--> statement-breakpoint
ALTER TABLE `content_posts` ADD `visual_prompt` text;