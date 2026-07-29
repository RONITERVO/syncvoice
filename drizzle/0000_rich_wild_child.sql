CREATE TABLE `characters` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`voice` text DEFAULT 'Kore' NOT NULL,
	`direction` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `characters_project_name_idx` ON `characters` (`project_id`,`name`);--> statement-breakpoint
CREATE INDEX `characters_project_idx` ON `characters` (`project_id`);--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`external_id` text NOT NULL,
	`scene` text DEFAULT '' NOT NULL,
	`speaker` text DEFAULT 'Narrator' NOT NULL,
	`text` text NOT NULL,
	`locale` text DEFAULT 'en-US' NOT NULL,
	`voice` text DEFAULT 'Kore' NOT NULL,
	`direction` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`transcript` text DEFAULT '' NOT NULL,
	`cues_json` text DEFAULT '[]' NOT NULL,
	`audio_key` text,
	`duration_ms` integer,
	`text_hash` text DEFAULT '' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entries_project_external_idx` ON `entries` (`project_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `entries_project_status_idx` ON `entries` (`project_id`,`status`);--> statement-breakpoint
CREATE INDEX `entries_project_scene_idx` ON `entries` (`project_id`,`scene`);--> statement-breakpoint
CREATE INDEX `entries_project_speaker_idx` ON `entries` (`project_id`,`speaker`);--> statement-breakpoint
CREATE TABLE `project_members` (
	`project_id` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `email`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `project_members_email_idx` ON `project_members` (`email`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_email` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source_locale` text DEFAULT 'en-US' NOT NULL,
	`target_engine` text DEFAULT 'universal' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `projects_owner_updated_idx` ON `projects` (`owner_email`,`updated_at`);