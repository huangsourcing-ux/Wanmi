import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_domain_assets_expiry_reminder_channels" AS ENUM('in_app', 'sms');
  CREATE TYPE "public"."enum_domain_assets_domain_lock_status" AS ENUM('locked', 'unlocked', 'unknown');
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'domain_lock' BEFORE 'domain_management_password';
  ALTER TYPE "public"."enum_domain_management_events_operation" ADD VALUE 'domain_lock_change' BEFORE 'management_password_read';
  ALTER TYPE "public"."enum_domain_management_events_operation" ADD VALUE 'expiry_reminder_preferences_update' BEFORE 'management_password_read';
  ALTER TYPE "public"."enum_domain_management_events_operation" ADD VALUE 'tags_update' BEFORE 'template_transfer';
  CREATE TABLE "domain_assets_expiry_reminder_channels" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_domain_assets_expiry_reminder_channels",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "domain_assets_numbers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"number" numeric,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL
  );
  
  ALTER TABLE "domain_assets" ADD COLUMN "domain_lock_status" "enum_domain_assets_domain_lock_status" DEFAULT 'unknown';
  ALTER TABLE "domain_assets" ADD COLUMN "domain_lock_updated_at" timestamp(3) with time zone;
  ALTER TABLE "domain_management_events" ADD COLUMN "previous_value" jsonb;
  ALTER TABLE "domain_management_events" ADD COLUMN "requested_value" jsonb;
  ALTER TABLE "domain_management_events" ADD COLUMN "requested_locked" boolean;
  ALTER TABLE "domain_assets_expiry_reminder_channels" ADD CONSTRAINT "domain_assets_expiry_reminder_channels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."domain_assets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "domain_assets_numbers" ADD CONSTRAINT "domain_assets_numbers_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."domain_assets"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "domain_assets_expiry_reminder_channels_order_idx" ON "domain_assets_expiry_reminder_channels" USING btree ("order");
  CREATE INDEX "domain_assets_expiry_reminder_channels_parent_idx" ON "domain_assets_expiry_reminder_channels" USING btree ("parent_id");
  CREATE INDEX "domain_assets_numbers_order_parent_idx" ON "domain_assets_numbers" USING btree ("order","parent_id");
  CREATE INDEX "domain_assets_domain_lock_status_idx" ON "domain_assets" USING btree ("domain_lock_status");
  CREATE INDEX "domain_assets_domain_lock_updated_at_idx" ON "domain_assets" USING btree ("domain_lock_updated_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DELETE FROM "provider_operations" WHERE "operation" = 'domain_lock';
  DELETE FROM "domain_management_events" WHERE "operation" IN ('domain_lock_change', 'expiry_reminder_preferences_update', 'tags_update');
  DELETE FROM "domain_assets_texts" WHERE "path" = 'tags';
   ALTER TABLE "domain_assets_expiry_reminder_channels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "domain_assets_numbers" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "domain_assets_expiry_reminder_channels" CASCADE;
  DROP TABLE "domain_assets_numbers" CASCADE;
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE text;
  DROP TYPE "public"."enum_provider_operations_operation";
  CREATE TYPE "public"."enum_provider_operations_operation" AS ENUM('realname', 'register', 'renew', 'refund', 'nameserver', 'query', 'dns_record_add', 'dns_record_modify', 'dns_record_delete', 'dns_record_batch_delete', 'dns_record_pause', 'domain_management_password', 'domain_contact_update', 'domain_template_transfer');
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE "public"."enum_provider_operations_operation" USING "operation"::"public"."enum_provider_operations_operation";
  ALTER TABLE "domain_management_events" ALTER COLUMN "operation" SET DATA TYPE text;
  DROP TYPE "public"."enum_domain_management_events_operation";
  CREATE TYPE "public"."enum_domain_management_events_operation" AS ENUM('management_password_read', 'management_password_modify', 'contact_information_update', 'template_transfer', 'certificate_download');
  ALTER TABLE "domain_management_events" ALTER COLUMN "operation" SET DATA TYPE "public"."enum_domain_management_events_operation" USING "operation"::"public"."enum_domain_management_events_operation";
  DROP INDEX "domain_assets_domain_lock_status_idx";
  DROP INDEX "domain_assets_domain_lock_updated_at_idx";
  ALTER TABLE "domain_assets" DROP COLUMN "domain_lock_status";
  ALTER TABLE "domain_assets" DROP COLUMN "domain_lock_updated_at";
  ALTER TABLE "domain_management_events" DROP COLUMN "previous_value";
  ALTER TABLE "domain_management_events" DROP COLUMN "requested_value";
  ALTER TABLE "domain_management_events" DROP COLUMN "requested_locked";
  DROP TYPE "public"."enum_domain_assets_expiry_reminder_channels";
  DROP TYPE "public"."enum_domain_assets_domain_lock_status";`)
}
