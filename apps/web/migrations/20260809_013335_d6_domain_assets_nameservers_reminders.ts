import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_domain_expiry_reminders_channel" AS ENUM('in_app', 'sms');
  CREATE TYPE "public"."enum_domain_expiry_reminders_status" AS ENUM('pending', 'sending', 'delivered', 'failed', 'unknown');
  CREATE TYPE "public"."enum_domain_expiry_reminders_failure_category" AS ENUM('balance_insufficient', 'template_unapproved', 'invalid_number', 'rate_limited', 'unknown');
  CREATE TYPE "public"."enum_nameserver_changes_requested_by_type" AS ENUM('customer');
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'domainExpiryReminders' BEFORE 'commerceFulfillment';
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'nameserverChange' BEFORE 'wechatRefund';
  CREATE TABLE "domain_expiry_reminders" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"reminder_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"channel" "enum_domain_expiry_reminders_channel" NOT NULL,
  	"threshold_days" numeric NOT NULL,
  	"expires_at_snapshot" timestamp(3) with time zone NOT NULL,
  	"status" "enum_domain_expiry_reminders_status" NOT NULL,
  	"attempted_at" timestamp(3) with time zone,
  	"delivered_at" timestamp(3) with time zone,
  	"failure_category" "enum_domain_expiry_reminders_failure_category",
  	"provider_code" varchar,
  	"provider_message_id" varchar,
  	"provider_request_id" varchar,
  	"created_trace_id" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "nameserver_changes" ADD COLUMN "change_key" varchar;
  ALTER TABLE "nameserver_changes" ADD COLUMN "requested_by_type" "enum_nameserver_changes_requested_by_type";
  ALTER TABLE "nameserver_changes" ADD COLUMN "requested_by_id" varchar;
  ALTER TABLE "nameserver_changes" ADD COLUMN "requested_at" timestamp(3) with time zone;
  ALTER TABLE "nameserver_changes" ADD COLUMN "job_queued_at" timestamp(3) with time zone;
  ALTER TABLE "nameserver_changes" ADD COLUMN "review_job_queued_at" timestamp(3) with time zone;
  ALTER TABLE "nameserver_changes" ADD COLUMN "last_checked_at" timestamp(3) with time zone;
  ALTER TABLE "nameserver_changes" ADD COLUMN "completed_at" timestamp(3) with time zone;
  ALTER TABLE "nameserver_changes" ADD COLUMN "provider_operation_id" integer;
  ALTER TABLE "nameserver_changes" ADD COLUMN "failure_code" varchar;
  ALTER TABLE "nameserver_changes" ADD COLUMN "created_trace_id" varchar;
  ALTER TABLE "manual_reviews" ADD COLUMN "domain_asset_id" integer;
  ALTER TABLE "manual_reviews" ADD COLUMN "nameserver_change_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "domain_expiry_reminders_id" integer;
  ALTER TABLE "domain_expiry_reminders" ADD CONSTRAINT "domain_expiry_reminders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_expiry_reminders" ADD CONSTRAINT "domain_expiry_reminders_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "domain_expiry_reminders_reminder_key_idx" ON "domain_expiry_reminders" USING btree ("reminder_key");
  CREATE INDEX "domain_expiry_reminders_customer_idx" ON "domain_expiry_reminders" USING btree ("customer_id");
  CREATE INDEX "domain_expiry_reminders_asset_idx" ON "domain_expiry_reminders" USING btree ("asset_id");
  CREATE INDEX "domain_expiry_reminders_expires_at_snapshot_idx" ON "domain_expiry_reminders" USING btree ("expires_at_snapshot");
  CREATE INDEX "domain_expiry_reminders_status_idx" ON "domain_expiry_reminders" USING btree ("status");
  CREATE INDEX "domain_expiry_reminders_attempted_at_idx" ON "domain_expiry_reminders" USING btree ("attempted_at");
  CREATE INDEX "domain_expiry_reminders_delivered_at_idx" ON "domain_expiry_reminders" USING btree ("delivered_at");
  CREATE INDEX "domain_expiry_reminders_provider_message_id_idx" ON "domain_expiry_reminders" USING btree ("provider_message_id");
  CREATE INDEX "domain_expiry_reminders_provider_request_id_idx" ON "domain_expiry_reminders" USING btree ("provider_request_id");
  CREATE INDEX "domain_expiry_reminders_created_trace_id_idx" ON "domain_expiry_reminders" USING btree ("created_trace_id");
  CREATE INDEX "domain_expiry_reminders_updated_at_idx" ON "domain_expiry_reminders" USING btree ("updated_at");
  CREATE INDEX "domain_expiry_reminders_created_at_idx" ON "domain_expiry_reminders" USING btree ("created_at");
  CREATE INDEX "asset_expiresAtSnapshot_idx" ON "domain_expiry_reminders" USING btree ("asset_id","expires_at_snapshot");
  ALTER TABLE "nameserver_changes" ADD CONSTRAINT "nameserver_changes_provider_operation_id_provider_operations_id_fk" FOREIGN KEY ("provider_operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_domain_asset_id_domain_assets_id_fk" FOREIGN KEY ("domain_asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_nameserver_change_id_nameserver_changes_id_fk" FOREIGN KEY ("nameserver_change_id") REFERENCES "public"."nameserver_changes"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_domain_expiry_reminders_fk" FOREIGN KEY ("domain_expiry_reminders_id") REFERENCES "public"."domain_expiry_reminders"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "nameserver_changes_change_key_idx" ON "nameserver_changes" USING btree ("change_key");
  CREATE INDEX "nameserver_changes_requested_at_idx" ON "nameserver_changes" USING btree ("requested_at");
  CREATE INDEX "nameserver_changes_job_queued_at_idx" ON "nameserver_changes" USING btree ("job_queued_at");
  CREATE INDEX "nameserver_changes_review_job_queued_at_idx" ON "nameserver_changes" USING btree ("review_job_queued_at");
  CREATE INDEX "nameserver_changes_last_checked_at_idx" ON "nameserver_changes" USING btree ("last_checked_at");
  CREATE INDEX "nameserver_changes_completed_at_idx" ON "nameserver_changes" USING btree ("completed_at");
  CREATE INDEX "nameserver_changes_provider_operation_idx" ON "nameserver_changes" USING btree ("provider_operation_id");
  CREATE INDEX "nameserver_changes_failure_code_idx" ON "nameserver_changes" USING btree ("failure_code");
  CREATE INDEX "nameserver_changes_created_trace_id_idx" ON "nameserver_changes" USING btree ("created_trace_id");
  CREATE INDEX "manual_reviews_domain_asset_idx" ON "manual_reviews" USING btree ("domain_asset_id");
  CREATE INDEX "manual_reviews_nameserver_change_idx" ON "manual_reviews" USING btree ("nameserver_change_id");
  CREATE INDEX "payload_locked_documents_rels_domain_expiry_reminders_id_idx" ON "payload_locked_documents_rels" USING btree ("domain_expiry_reminders_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_domain_expiry_reminders_fk";
  DROP INDEX "payload_locked_documents_rels_domain_expiry_reminders_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "domain_expiry_reminders_id";
  ALTER TABLE "domain_expiry_reminders" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "domain_expiry_reminders" CASCADE;
  ALTER TABLE "nameserver_changes" DROP CONSTRAINT "nameserver_changes_provider_operation_id_provider_operations_id_fk";
  
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_domain_asset_id_domain_assets_id_fk";
  
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_nameserver_change_id_nameserver_changes_id_fk";
  
  DELETE FROM "payload_jobs"
  WHERE "workflow_slug"::text IN ('domainExpiryReminders', 'nameserverChange');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'commerceFulfillment', 'wechatRefund', 'paymentTimeoutClose');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "nameserver_changes_change_key_idx";
  DROP INDEX "nameserver_changes_requested_at_idx";
  DROP INDEX "nameserver_changes_job_queued_at_idx";
  DROP INDEX "nameserver_changes_review_job_queued_at_idx";
  DROP INDEX "nameserver_changes_last_checked_at_idx";
  DROP INDEX "nameserver_changes_completed_at_idx";
  DROP INDEX "nameserver_changes_provider_operation_idx";
  DROP INDEX "nameserver_changes_failure_code_idx";
  DROP INDEX "nameserver_changes_created_trace_id_idx";
  DROP INDEX "manual_reviews_domain_asset_idx";
  DROP INDEX "manual_reviews_nameserver_change_idx";
  ALTER TABLE "nameserver_changes" DROP COLUMN "change_key";
  ALTER TABLE "nameserver_changes" DROP COLUMN "requested_by_type";
  ALTER TABLE "nameserver_changes" DROP COLUMN "requested_by_id";
  ALTER TABLE "nameserver_changes" DROP COLUMN "requested_at";
  ALTER TABLE "nameserver_changes" DROP COLUMN "job_queued_at";
  ALTER TABLE "nameserver_changes" DROP COLUMN "review_job_queued_at";
  ALTER TABLE "nameserver_changes" DROP COLUMN "last_checked_at";
  ALTER TABLE "nameserver_changes" DROP COLUMN "completed_at";
  ALTER TABLE "nameserver_changes" DROP COLUMN "provider_operation_id";
  ALTER TABLE "nameserver_changes" DROP COLUMN "failure_code";
  ALTER TABLE "nameserver_changes" DROP COLUMN "created_trace_id";
  ALTER TABLE "manual_reviews" DROP COLUMN "domain_asset_id";
  ALTER TABLE "manual_reviews" DROP COLUMN "nameserver_change_id";
  DROP TYPE "public"."enum_domain_expiry_reminders_channel";
  DROP TYPE "public"."enum_domain_expiry_reminders_status";
  DROP TYPE "public"."enum_domain_expiry_reminders_failure_category";
  DROP TYPE "public"."enum_nameserver_changes_requested_by_type";`)
}
