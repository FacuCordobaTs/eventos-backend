-- Allow the same email to exist in multiple tenants (one record per tenant).
-- Replace the global unique email index with a composite (email, tenant_id) unique index.
ALTER TABLE `staff` DROP INDEX `email`;--> statement-breakpoint
CREATE UNIQUE INDEX `staff_email_tenant_unique` ON `staff` (`email`, `tenant_id`);
