ALTER TABLE "connection" ADD COLUMN "tools_sync_started_at" bigint;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "refresh_lease_until" bigint;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "refresh_lease_holder" text;--> statement-breakpoint
ALTER TABLE "connection" ADD COLUMN "oauth_refreshed_at" bigint;