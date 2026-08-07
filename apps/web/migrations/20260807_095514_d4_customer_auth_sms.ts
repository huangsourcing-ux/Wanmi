import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sms_challenges_delivery_status" AS ENUM('not_requested', 'accepted', 'pending', 'delivered', 'failed', 'unknown');
  CREATE TYPE "public"."enum_sms_challenges_delivery_failure_category" AS ENUM('balance_insufficient', 'template_unapproved', 'invalid_number', 'rate_limited', 'unknown');
  CREATE TYPE "public"."enum_sms_rate_limits_dimension" AS ENUM('phone', 'ip', 'device', 'global');
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'smsReceiptReconciliation' BEFORE 'commerceFulfillment';
  CREATE TABLE "sms_rate_limits" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"bucket_key" varchar NOT NULL,
  	"dimension" "enum_sms_rate_limits_dimension" NOT NULL,
  	"identity_hash" varchar NOT NULL,
  	"window_started_at" timestamp(3) with time zone NOT NULL,
  	"count" numeric NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "customers" ADD COLUMN "deletion_requested_at" timestamp(3) with time zone;
  ALTER TABLE "sms_challenges" ADD COLUMN "delivery_status" "enum_sms_challenges_delivery_status" DEFAULT 'not_requested' NOT NULL;
  ALTER TABLE "sms_challenges" ADD COLUMN "delivery_failure_category" "enum_sms_challenges_delivery_failure_category";
  ALTER TABLE "sms_challenges" ADD COLUMN "delivery_provider_code" varchar;
  ALTER TABLE "sms_challenges" ADD COLUMN "provider_message_id" varchar;
  ALTER TABLE "sms_challenges" ADD COLUMN "provider_request_id" varchar;
  ALTER TABLE "sms_challenges" ADD COLUMN "receipt_request_id" varchar;
  ALTER TABLE "sms_challenges" ADD COLUMN "sent_at" timestamp(3) with time zone;
  ALTER TABLE "sms_challenges" ADD COLUMN "receipt_checked_at" timestamp(3) with time zone;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "sms_rate_limits_id" integer;
  CREATE UNIQUE INDEX "sms_rate_limits_bucket_key_idx" ON "sms_rate_limits" USING btree ("bucket_key");
  CREATE INDEX "sms_rate_limits_dimension_idx" ON "sms_rate_limits" USING btree ("dimension");
  CREATE INDEX "sms_rate_limits_identity_hash_idx" ON "sms_rate_limits" USING btree ("identity_hash");
  CREATE INDEX "sms_rate_limits_window_started_at_idx" ON "sms_rate_limits" USING btree ("window_started_at");
  CREATE INDEX "sms_rate_limits_expires_at_idx" ON "sms_rate_limits" USING btree ("expires_at");
  CREATE INDEX "sms_rate_limits_updated_at_idx" ON "sms_rate_limits" USING btree ("updated_at");
  CREATE INDEX "sms_rate_limits_created_at_idx" ON "sms_rate_limits" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sms_rate_limits_fk" FOREIGN KEY ("sms_rate_limits_id") REFERENCES "public"."sms_rate_limits"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "customers_deletion_requested_at_idx" ON "customers" USING btree ("deletion_requested_at");
  CREATE INDEX "sms_challenges_delivery_status_idx" ON "sms_challenges" USING btree ("delivery_status");
  CREATE INDEX "sms_challenges_provider_message_id_idx" ON "sms_challenges" USING btree ("provider_message_id");
  CREATE INDEX "sms_challenges_provider_request_id_idx" ON "sms_challenges" USING btree ("provider_request_id");
  CREATE INDEX "sms_challenges_receipt_request_id_idx" ON "sms_challenges" USING btree ("receipt_request_id");
  CREATE INDEX "sms_challenges_sent_at_idx" ON "sms_challenges" USING btree ("sent_at");
  CREATE INDEX "sms_challenges_receipt_checked_at_idx" ON "sms_challenges" USING btree ("receipt_checked_at");
  CREATE INDEX "payload_locked_documents_rels_sms_rate_limits_id_idx" ON "payload_locked_documents_rels" USING btree ("sms_rate_limits_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_sms_rate_limits_fk";
  DROP INDEX "payload_locked_documents_rels_sms_rate_limits_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "sms_rate_limits_id";
  ALTER TABLE "sms_rate_limits" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "sms_rate_limits";
  
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'commerceFulfillment');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "customers_deletion_requested_at_idx";
  DROP INDEX "sms_challenges_delivery_status_idx";
  DROP INDEX "sms_challenges_provider_message_id_idx";
  DROP INDEX "sms_challenges_provider_request_id_idx";
  DROP INDEX "sms_challenges_receipt_request_id_idx";
  DROP INDEX "sms_challenges_sent_at_idx";
  DROP INDEX "sms_challenges_receipt_checked_at_idx";
  ALTER TABLE "customers" DROP COLUMN "deletion_requested_at";
  ALTER TABLE "sms_challenges" DROP COLUMN "delivery_status";
  ALTER TABLE "sms_challenges" DROP COLUMN "delivery_failure_category";
  ALTER TABLE "sms_challenges" DROP COLUMN "delivery_provider_code";
  ALTER TABLE "sms_challenges" DROP COLUMN "provider_message_id";
  ALTER TABLE "sms_challenges" DROP COLUMN "provider_request_id";
  ALTER TABLE "sms_challenges" DROP COLUMN "receipt_request_id";
  ALTER TABLE "sms_challenges" DROP COLUMN "sent_at";
  ALTER TABLE "sms_challenges" DROP COLUMN "receipt_checked_at";
  DROP TYPE "public"."enum_sms_challenges_delivery_status";
  DROP TYPE "public"."enum_sms_challenges_delivery_failure_category";
  DROP TYPE "public"."enum_sms_rate_limits_dimension";`)
}
