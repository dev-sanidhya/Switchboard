CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `provider_health` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`state` text DEFAULT 'closed' NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_failure_at` integer,
	`opened_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `provider_health_provider_unique` ON `provider_health` (`provider`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`trace_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`requested_model` text NOT NULL,
	`routed_provider` text,
	`routed_model` text,
	`input_tokens` integer,
	`output_tokens` integer,
	`cost_usd` real,
	`latency_ms` integer,
	`ttfb_ms` integer,
	`status` text NOT NULL,
	`error_code` text,
	`cached` integer DEFAULT false NOT NULL,
	`streaming` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tenant_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`requests_per_minute` integer DEFAULT 60 NOT NULL,
	`budget_usd_monthly` real DEFAULT 10 NOT NULL,
	`budget_used_usd` real DEFAULT 0 NOT NULL,
	`budget_reset_at` integer NOT NULL,
	`allowed_providers` text,
	`allowed_models` text,
	`routing_policy` text DEFAULT 'cost' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_limits_tenant_id_unique` ON `tenant_limits` (`tenant_id`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
