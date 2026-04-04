CREATE TABLE `content_ideas` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`pillar` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`batch_id` text,
	`post_id` integer,
	`rejection_reason` text,
	`revision_feedback` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`concept` text NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`scheduled_at` text,
	`idea_id` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `platform_variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`post_id` integer NOT NULL,
	`platform` text NOT NULL,
	`caption` text,
	`caption_status` text DEFAULT 'pending' NOT NULL,
	`image_url` text,
	`image_status` text DEFAULT 'pending' NOT NULL,
	`aspect_ratio` text,
	`buffer_post_id` text,
	`publish_status` text DEFAULT 'draft' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `variant_versions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`variant_id` integer NOT NULL,
	`caption` text,
	`image_url` text,
	`feedback` text,
	`created_at` text NOT NULL
);
