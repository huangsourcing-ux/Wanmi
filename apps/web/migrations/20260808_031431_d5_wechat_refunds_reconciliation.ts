import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_refund_notifications_source" AS ENUM('notification', 'query');
  CREATE TYPE "public"."enum_refund_notifications_confirmation_status" AS ENUM('confirmed', 'mismatch', 'failed', 'rejected', 'unknown');
  CREATE TYPE "public"."enum_refund_notifications_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_refunds_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_refunds_failure_category" AS ENUM('balance_insufficient', 'disputed', 'provider_rejected', 'unknown');
  CREATE TYPE "public"."enum_reconciliations_ledger" AS ENUM('wechat_funds', 'westdigital_prepaid', 'internal_orders');
  CREATE TYPE "public"."enum_reconciliations_currency" AS ENUM('CNY');
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'wechatRefund';
  CREATE TABLE "refund_notifications" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"notification_id" varchar NOT NULL,
  	"refund_id" integer,
  	"source" "enum_refund_notifications_source" NOT NULL,
  	"confirmation_status" "enum_refund_notifications_confirmation_status" NOT NULL,
  	"refund_number" varchar,
  	"provider_refund_id" varchar,
  	"amount_minor" numeric,
  	"currency" "enum_refund_notifications_currency",
  	"signature_verified" boolean DEFAULT false NOT NULL,
  	"received_at" timestamp(3) with time zone NOT NULL,
  	"refunded_at" timestamp(3) with time zone,
  	"payload_digest" varchar NOT NULL,
  	"provider_request_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  DROP INDEX "refunds_order_idx";
  ALTER TABLE "refunds" ADD COLUMN "currency" "enum_refunds_currency" DEFAULT 'CNY' NOT NULL;
  ALTER TABLE "refunds" ADD COLUMN "failure_category" "enum_refunds_failure_category";
  ALTER TABLE "refunds" ADD COLUMN "submitted_at" timestamp(3) with time zone;
  ALTER TABLE "refunds" ADD COLUMN "last_checked_at" timestamp(3) with time zone;
  ALTER TABLE "refunds" ADD COLUMN "refunded_at" timestamp(3) with time zone;
  ALTER TABLE "refunds" ADD COLUMN "created_trace_id" varchar;
  UPDATE "refunds" SET "created_trace_id" = 'LEGACY-REFUND-' || "id"::text;
  ALTER TABLE "refunds" ALTER COLUMN "created_trace_id" SET NOT NULL;
  ALTER TABLE "reconciliations" ADD COLUMN "reconciliation_key" varchar;
  ALTER TABLE "reconciliations" ADD COLUMN "ledger" "enum_reconciliations_ledger";
  ALTER TABLE "reconciliations" ADD COLUMN "record_key" varchar;
  ALTER TABLE "reconciliations" ADD COLUMN "difference_minor" numeric;
  ALTER TABLE "reconciliations" ADD COLUMN "currency" "enum_reconciliations_currency";
  ALTER TABLE "reconciliations" ADD COLUMN "trace_id" varchar;
  UPDATE "reconciliations"
  SET
    "reconciliation_key" = 'LEGACY-RECONCILIATION-' || "id"::text,
    "ledger" = CASE
      WHEN "kind" = 'wechat' THEN 'wechat_funds'::"enum_reconciliations_ledger"
      WHEN "kind" = 'westdigital' THEN 'westdigital_prepaid'::"enum_reconciliations_ledger"
      ELSE 'internal_orders'::"enum_reconciliations_ledger"
    END,
    "record_key" = 'legacy:' || "id"::text,
    "difference_minor" = 0,
    "currency" = 'CNY'::"enum_reconciliations_currency",
    "trace_id" = 'LEGACY-RECONCILIATION-' || "id"::text;
  ALTER TABLE "reconciliations" ALTER COLUMN "reconciliation_key" SET NOT NULL;
  ALTER TABLE "reconciliations" ALTER COLUMN "ledger" SET NOT NULL;
  ALTER TABLE "reconciliations" ALTER COLUMN "record_key" SET NOT NULL;
  ALTER TABLE "reconciliations" ALTER COLUMN "difference_minor" SET NOT NULL;
  ALTER TABLE "reconciliations" ALTER COLUMN "currency" SET NOT NULL;
  ALTER TABLE "reconciliations" ALTER COLUMN "trace_id" SET NOT NULL;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "refund_notifications_id" integer;
  ALTER TABLE "refund_notifications" ADD CONSTRAINT "refund_notifications_refund_id_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."refunds"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "refund_notifications_notification_id_idx" ON "refund_notifications" USING btree ("notification_id");
  CREATE INDEX "refund_notifications_refund_idx" ON "refund_notifications" USING btree ("refund_id");
  CREATE INDEX "refund_notifications_refund_number_idx" ON "refund_notifications" USING btree ("refund_number");
  CREATE INDEX "refund_notifications_provider_refund_id_idx" ON "refund_notifications" USING btree ("provider_refund_id");
  CREATE INDEX "refund_notifications_updated_at_idx" ON "refund_notifications" USING btree ("updated_at");
  CREATE INDEX "refund_notifications_created_at_idx" ON "refund_notifications" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_refund_notifications_fk" FOREIGN KEY ("refund_notifications_id") REFERENCES "public"."refund_notifications"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "reconciliations_reconciliation_key_idx" ON "reconciliations" USING btree ("reconciliation_key");
  CREATE INDEX "reconciliations_record_key_idx" ON "reconciliations" USING btree ("record_key");
  CREATE INDEX "reconciliations_trace_id_idx" ON "reconciliations" USING btree ("trace_id");
  CREATE INDEX "ledger_periodStart_periodEnd_idx" ON "reconciliations" USING btree ("ledger","period_start","period_end");
  CREATE INDEX "payload_locked_documents_rels_refund_notifications_id_idx" ON "payload_locked_documents_rels" USING btree ("refund_notifications_id");
  CREATE UNIQUE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_refund_notifications_fk";
  ALTER TABLE "refund_notifications" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "refund_notifications" CASCADE;
  
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'commerceFulfillment');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "reconciliations_reconciliation_key_idx";
  DROP INDEX "reconciliations_record_key_idx";
  DROP INDEX "reconciliations_trace_id_idx";
  DROP INDEX "ledger_periodStart_periodEnd_idx";
  DROP INDEX "payload_locked_documents_rels_refund_notifications_id_idx";
  DROP INDEX "refunds_order_idx";
  CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");
  ALTER TABLE "refunds" DROP COLUMN "currency";
  ALTER TABLE "refunds" DROP COLUMN "failure_category";
  ALTER TABLE "refunds" DROP COLUMN "submitted_at";
  ALTER TABLE "refunds" DROP COLUMN "last_checked_at";
  ALTER TABLE "refunds" DROP COLUMN "refunded_at";
  ALTER TABLE "refunds" DROP COLUMN "created_trace_id";
  ALTER TABLE "reconciliations" DROP COLUMN "reconciliation_key";
  ALTER TABLE "reconciliations" DROP COLUMN "ledger";
  ALTER TABLE "reconciliations" DROP COLUMN "record_key";
  ALTER TABLE "reconciliations" DROP COLUMN "difference_minor";
  ALTER TABLE "reconciliations" DROP COLUMN "currency";
  ALTER TABLE "reconciliations" DROP COLUMN "trace_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "refund_notifications_id";
  DROP TYPE "public"."enum_refund_notifications_source";
  DROP TYPE "public"."enum_refund_notifications_confirmation_status";
  DROP TYPE "public"."enum_refund_notifications_currency";
  DROP TYPE "public"."enum_refunds_currency";
  DROP TYPE "public"."enum_refunds_failure_category";
  DROP TYPE "public"."enum_reconciliations_ledger";
  DROP TYPE "public"."enum_reconciliations_currency";`)
}
