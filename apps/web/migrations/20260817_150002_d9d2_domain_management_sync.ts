import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_domain_assets_upstream_ownership_status" AS ENUM('confirmed', 'not_owned', 'unknown');
  CREATE TYPE "public"."enum_domain_assets_sync_review_status" AS ENUM('none', 'matched', 'pending');
  CREATE TYPE "public"."enum_domain_management_events_operation" AS ENUM('management_password_read', 'management_password_modify', 'contact_information_update', 'template_transfer', 'certificate_download');
  CREATE TYPE "public"."enum_domain_management_events_event" AS ENUM('requested', 'confirmed', 'failed', 'pending_query');
  CREATE TYPE "public"."enum_domain_management_events_contact_type" AS ENUM('dom_id', 'admin_id', 'tech_id', 'bill_id');
  CREATE TYPE "public"."enum_domain_asset_sync_events_outcome" AS ENUM('matched', 'difference', 'not_owned', 'ownership_unknown');
  CREATE TYPE "public"."enum_domain_asset_sync_events_resolution_status" AS ENUM('not_required', 'pending');
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'domain_management_password';
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'domain_contact_update';
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'domain_template_transfer';
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'domainAssetSynchronization' BEFORE 'walletLedgerConsistencyCheck';
  CREATE TABLE "domain_management_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"operation" "enum_domain_management_events_operation" NOT NULL,
  	"event" "enum_domain_management_events_event" NOT NULL,
  	"contact_type" "enum_domain_management_events_contact_type",
  	"realname_template_id" integer,
  	"provider_operation_id" integer,
  	"operation_key" varchar,
  	"error_code" varchar,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"trace_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "domain_asset_sync_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"outcome" "enum_domain_asset_sync_events_outcome" NOT NULL,
  	"resolution_status" "enum_domain_asset_sync_events_resolution_status" NOT NULL,
  	"local_facts" jsonb,
  	"upstream_facts" jsonb,
  	"differences" jsonb,
  	"provider_error_code" varchar,
  	"observed_at" timestamp(3) with time zone NOT NULL,
  	"trace_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "domain_assets" ADD COLUMN "upstream_ownership_status" "enum_domain_assets_upstream_ownership_status" DEFAULT 'unknown' NOT NULL;
  ALTER TABLE "domain_assets" ADD COLUMN "sync_review_status" "enum_domain_assets_sync_review_status" DEFAULT 'none' NOT NULL;
  ALTER TABLE "domain_assets" ADD COLUMN "sync_version" numeric DEFAULT 0 NOT NULL;
  ALTER TABLE "domain_assets" ADD COLUMN "last_ownership_checked_at" timestamp(3) with time zone;
  ALTER TABLE "domain_assets" ADD COLUMN "operation_blocked_at" timestamp(3) with time zone;
  ALTER TABLE "domain_assets" ADD COLUMN "operation_block_reason" varchar;
  ALTER TABLE "domain_assets" ADD COLUMN "domain_management_lease_key" varchar;
  ALTER TABLE "domain_assets" ADD COLUMN "domain_management_lease_expires_at" timestamp(3) with time zone;
  ALTER TABLE "domain_management_events" ADD CONSTRAINT "domain_management_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_management_events" ADD CONSTRAINT "domain_management_events_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_management_events" ADD CONSTRAINT "domain_management_events_realname_template_id_realname_templates_id_fk" FOREIGN KEY ("realname_template_id") REFERENCES "public"."realname_templates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_management_events" ADD CONSTRAINT "domain_management_events_provider_operation_id_provider_operations_id_fk" FOREIGN KEY ("provider_operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_asset_sync_events" ADD CONSTRAINT "domain_asset_sync_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_asset_sync_events" ADD CONSTRAINT "domain_asset_sync_events_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "domain_management_events_event_key_idx" ON "domain_management_events" USING btree ("event_key");
  CREATE INDEX "domain_management_events_customer_idx" ON "domain_management_events" USING btree ("customer_id");
  CREATE INDEX "domain_management_events_asset_idx" ON "domain_management_events" USING btree ("asset_id");
  CREATE INDEX "domain_management_events_realname_template_idx" ON "domain_management_events" USING btree ("realname_template_id");
  CREATE INDEX "domain_management_events_provider_operation_idx" ON "domain_management_events" USING btree ("provider_operation_id");
  CREATE INDEX "domain_management_events_operation_key_idx" ON "domain_management_events" USING btree ("operation_key");
  CREATE INDEX "domain_management_events_error_code_idx" ON "domain_management_events" USING btree ("error_code");
  CREATE INDEX "domain_management_events_occurred_at_idx" ON "domain_management_events" USING btree ("occurred_at");
  CREATE INDEX "domain_management_events_trace_id_idx" ON "domain_management_events" USING btree ("trace_id");
  CREATE INDEX "domain_management_events_updated_at_idx" ON "domain_management_events" USING btree ("updated_at");
  CREATE INDEX "domain_management_events_created_at_idx" ON "domain_management_events" USING btree ("created_at");
  CREATE INDEX "asset_occurredAt_1_idx" ON "domain_management_events" USING btree ("asset_id","occurred_at");
  CREATE INDEX "customer_occurredAt_2_idx" ON "domain_management_events" USING btree ("customer_id","occurred_at");
  CREATE UNIQUE INDEX "domain_asset_sync_events_event_key_idx" ON "domain_asset_sync_events" USING btree ("event_key");
  CREATE INDEX "domain_asset_sync_events_customer_idx" ON "domain_asset_sync_events" USING btree ("customer_id");
  CREATE INDEX "domain_asset_sync_events_asset_idx" ON "domain_asset_sync_events" USING btree ("asset_id");
  CREATE INDEX "domain_asset_sync_events_observed_at_idx" ON "domain_asset_sync_events" USING btree ("observed_at");
  CREATE INDEX "domain_asset_sync_events_trace_id_idx" ON "domain_asset_sync_events" USING btree ("trace_id");
  CREATE INDEX "domain_asset_sync_events_updated_at_idx" ON "domain_asset_sync_events" USING btree ("updated_at");
  CREATE INDEX "domain_asset_sync_events_created_at_idx" ON "domain_asset_sync_events" USING btree ("created_at");
  CREATE INDEX "asset_observedAt_idx" ON "domain_asset_sync_events" USING btree ("asset_id","observed_at");
  CREATE INDEX "resolutionStatus_observedAt_idx" ON "domain_asset_sync_events" USING btree ("resolution_status","observed_at");
  CREATE INDEX "domain_assets_last_ownership_checked_at_idx" ON "domain_assets" USING btree ("last_ownership_checked_at");
  CREATE INDEX "domain_assets_operation_blocked_at_idx" ON "domain_assets" USING btree ("operation_blocked_at");
  CREATE INDEX "domain_assets_domain_management_lease_key_idx" ON "domain_assets" USING btree ("domain_management_lease_key");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "domain_management_events" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "domain_asset_sync_events" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "domain_management_events" CASCADE;
  DROP TABLE "domain_asset_sync_events" CASCADE;
  DELETE FROM "provider_operations"
  WHERE "operation"::text IN ('domain_management_password', 'domain_contact_update', 'domain_template_transfer');
  DELETE FROM "payload_jobs"
  WHERE "workflow_slug"::text = 'domainAssetSynchronization';
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE text;
  DROP TYPE "public"."enum_provider_operations_operation";
  CREATE TYPE "public"."enum_provider_operations_operation" AS ENUM('realname', 'register', 'renew', 'refund', 'nameserver', 'query', 'dns_record_add', 'dns_record_modify', 'dns_record_delete', 'dns_record_pause');
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE "public"."enum_provider_operations_operation" USING "operation"::"public"."enum_provider_operations_operation";
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'walletLedgerConsistencyCheck', 'commerceFulfillment', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "domain_assets_last_ownership_checked_at_idx";
  DROP INDEX "domain_assets_operation_blocked_at_idx";
  DROP INDEX "domain_assets_domain_management_lease_key_idx";
  ALTER TABLE "domain_assets" DROP COLUMN "upstream_ownership_status";
  ALTER TABLE "domain_assets" DROP COLUMN "sync_review_status";
  ALTER TABLE "domain_assets" DROP COLUMN "sync_version";
  ALTER TABLE "domain_assets" DROP COLUMN "last_ownership_checked_at";
  ALTER TABLE "domain_assets" DROP COLUMN "operation_blocked_at";
  ALTER TABLE "domain_assets" DROP COLUMN "operation_block_reason";
  ALTER TABLE "domain_assets" DROP COLUMN "domain_management_lease_key";
  ALTER TABLE "domain_assets" DROP COLUMN "domain_management_lease_expires_at";
  DROP TYPE "public"."enum_domain_assets_upstream_ownership_status";
  DROP TYPE "public"."enum_domain_assets_sync_review_status";
  DROP TYPE "public"."enum_domain_management_events_operation";
  DROP TYPE "public"."enum_domain_management_events_event";
  DROP TYPE "public"."enum_domain_management_events_contact_type";
  DROP TYPE "public"."enum_domain_asset_sync_events_outcome";
  DROP TYPE "public"."enum_domain_asset_sync_events_resolution_status";`)
}
