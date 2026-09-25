ALTER TABLE `connection` ADD `refresh_lease_until` blob;--> statement-breakpoint
ALTER TABLE `connection` ADD `refresh_lease_holder` text;--> statement-breakpoint
ALTER TABLE `connection` ADD `oauth_refreshed_at` blob;