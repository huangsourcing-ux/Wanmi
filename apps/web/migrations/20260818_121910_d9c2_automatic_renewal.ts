import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_domain_expiry_reminders_notice_type" AS ENUM('expiry', 'automatic_renewal_enabled', 'automatic_renewal_due', 'automatic_renewal_balance_insufficient', 'automatic_renewal_price_changed', 'automatic_renewal_blocked');
  CREATE TYPE "public"."enum_renewal_mandates_scope" AS ENUM('renew_one_year');
  CREATE TYPE "public"."enum_renewal_mandates_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_renewal_mandates_event_type" AS ENUM('authorized', 'revoked');
  CREATE TYPE "public"."enum_automatic_renewal_events_event_type" AS ENUM('attempt_claimed', 'balance_insufficient', 'price_changed', 'order_queued', 'skipped_invalid_mandate', 'skipped_account_restricted', 'skipped_identity_cooldown', 'skipped_not_owned', 'skipped_domain_status', 'skipped_job_revalidation');
  ALTER TYPE "public"."enum_sms_challenges_step_up_purpose" ADD VALUE 'renewal_mandate_change' BEFORE 'account_deletion';
  ALTER TYPE "public"."enum_step_up_grants_purpose" ADD VALUE 'renewal_mandate_change' BEFORE 'account_deletion';
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'automaticRenewalScheduling' BEFORE 'commerceWorkerHeartbeat';
  CREATE TABLE "renewal_mandates" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"mandate_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"domain_ascii_snapshot" varchar NOT NULL,
  	"scope" "enum_renewal_mandates_scope" NOT NULL,
  	"max_debit_fen" numeric NOT NULL,
  	"currency" "enum_renewal_mandates_currency" NOT NULL,
  	"authorized_at" timestamp(3) with time zone NOT NULL,
  	"valid_until" timestamp(3) with time zone NOT NULL,
  	"rules_version" varchar NOT NULL,
  	"revision" numeric NOT NULL,
  	"event_type" "enum_renewal_mandates_event_type" NOT NULL,
  	"revoked_at" timestamp(3) with time zone,
  	"previous_mandate_id" integer,
  	"step_up_grant_id" varchar NOT NULL,
  	"preview_digest" varchar NOT NULL,
  	"created_trace_id" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "automatic_renewal_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"mandate_id" integer NOT NULL,
  	"attempt_key" varchar,
  	"attempt_slot_days" numeric,
  	"expires_at_snapshot" timestamp(3) with time zone NOT NULL,
  	"event_type" "enum_automatic_renewal_events_event_type" NOT NULL,
  	"amount_fen" numeric,
  	"authorized_max_amount_fen" numeric,
  	"available_balance_fen" numeric,
  	"order_id" integer,
  	"reason_code" varchar,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"trace_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "orders" ADD COLUMN "automatic_renewal_mandate_id" integer;
  ALTER TABLE "orders" ADD COLUMN "automatic_renewal_attempt_key" varchar;
  ALTER TABLE "orders" ADD COLUMN "automatic_renewal_rules_version" varchar;
  ALTER TABLE "orders" ADD COLUMN "balance_hold_transaction_key" varchar;
  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "notice_type" "enum_domain_expiry_reminders_notice_type" DEFAULT 'expiry' NOT NULL;
  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "mandate_id" integer;
  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "amount_fen" numeric;
  ALTER TABLE "domain_expiry_reminders" ADD COLUMN "authorized_max_amount_fen" numeric;
  ALTER TABLE "renewal_mandates" ADD CONSTRAINT "renewal_mandates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "renewal_mandates" ADD CONSTRAINT "renewal_mandates_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "renewal_mandates" ADD CONSTRAINT "renewal_mandates_previous_mandate_id_renewal_mandates_id_fk" FOREIGN KEY ("previous_mandate_id") REFERENCES "public"."renewal_mandates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "automatic_renewal_events" ADD CONSTRAINT "automatic_renewal_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "automatic_renewal_events" ADD CONSTRAINT "automatic_renewal_events_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "automatic_renewal_events" ADD CONSTRAINT "automatic_renewal_events_mandate_id_renewal_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."renewal_mandates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "automatic_renewal_events" ADD CONSTRAINT "automatic_renewal_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "renewal_mandates_mandate_key_idx" ON "renewal_mandates" USING btree ("mandate_key");
  CREATE INDEX "renewal_mandates_customer_idx" ON "renewal_mandates" USING btree ("customer_id");
  CREATE INDEX "renewal_mandates_asset_idx" ON "renewal_mandates" USING btree ("asset_id");
  CREATE INDEX "renewal_mandates_domain_ascii_snapshot_idx" ON "renewal_mandates" USING btree ("domain_ascii_snapshot");
  CREATE INDEX "renewal_mandates_authorized_at_idx" ON "renewal_mandates" USING btree ("authorized_at");
  CREATE INDEX "renewal_mandates_valid_until_idx" ON "renewal_mandates" USING btree ("valid_until");
  CREATE INDEX "renewal_mandates_revoked_at_idx" ON "renewal_mandates" USING btree ("revoked_at");
  CREATE INDEX "renewal_mandates_previous_mandate_idx" ON "renewal_mandates" USING btree ("previous_mandate_id");
  CREATE INDEX "renewal_mandates_updated_at_idx" ON "renewal_mandates" USING btree ("updated_at");
  CREATE INDEX "renewal_mandates_created_at_idx" ON "renewal_mandates" USING btree ("created_at");
  CREATE UNIQUE INDEX "asset_revision_idx" ON "renewal_mandates" USING btree ("asset_id","revision");
  CREATE INDEX "customer_authorizedAt_idx" ON "renewal_mandates" USING btree ("customer_id","authorized_at");
  CREATE UNIQUE INDEX "automatic_renewal_events_event_key_idx" ON "automatic_renewal_events" USING btree ("event_key");
  CREATE INDEX "automatic_renewal_events_customer_idx" ON "automatic_renewal_events" USING btree ("customer_id");
  CREATE INDEX "automatic_renewal_events_asset_idx" ON "automatic_renewal_events" USING btree ("asset_id");
  CREATE INDEX "automatic_renewal_events_mandate_idx" ON "automatic_renewal_events" USING btree ("mandate_id");
  CREATE INDEX "automatic_renewal_events_attempt_key_idx" ON "automatic_renewal_events" USING btree ("attempt_key");
  CREATE INDEX "automatic_renewal_events_expires_at_snapshot_idx" ON "automatic_renewal_events" USING btree ("expires_at_snapshot");
  CREATE INDEX "automatic_renewal_events_order_idx" ON "automatic_renewal_events" USING btree ("order_id");
  CREATE INDEX "automatic_renewal_events_reason_code_idx" ON "automatic_renewal_events" USING btree ("reason_code");
  CREATE INDEX "automatic_renewal_events_occurred_at_idx" ON "automatic_renewal_events" USING btree ("occurred_at");
  CREATE INDEX "automatic_renewal_events_trace_id_idx" ON "automatic_renewal_events" USING btree ("trace_id");
  CREATE INDEX "automatic_renewal_events_updated_at_idx" ON "automatic_renewal_events" USING btree ("updated_at");
  CREATE INDEX "automatic_renewal_events_created_at_idx" ON "automatic_renewal_events" USING btree ("created_at");
  CREATE INDEX "asset_expiresAtSnapshot_1_idx" ON "automatic_renewal_events" USING btree ("asset_id","expires_at_snapshot");
  CREATE INDEX "customer_occurredAt_4_idx" ON "automatic_renewal_events" USING btree ("customer_id","occurred_at");
  ALTER TABLE "orders" ADD CONSTRAINT "orders_automatic_renewal_mandate_id_renewal_mandates_id_fk" FOREIGN KEY ("automatic_renewal_mandate_id") REFERENCES "public"."renewal_mandates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_expiry_reminders" ADD CONSTRAINT "domain_expiry_reminders_mandate_id_renewal_mandates_id_fk" FOREIGN KEY ("mandate_id") REFERENCES "public"."renewal_mandates"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "orders_automatic_renewal_mandate_idx" ON "orders" USING btree ("automatic_renewal_mandate_id");
  CREATE UNIQUE INDEX "orders_automatic_renewal_attempt_key_idx" ON "orders" USING btree ("automatic_renewal_attempt_key");
  CREATE INDEX "orders_balance_hold_transaction_key_idx" ON "orders" USING btree ("balance_hold_transaction_key");
  CREATE INDEX "domain_expiry_reminders_mandate_idx" ON "domain_expiry_reminders" USING btree ("mandate_id");
  CREATE INDEX "asset_noticeType_expiresAtSnapshot_idx" ON "domain_expiry_reminders" USING btree ("asset_id","notice_type","expires_at_snapshot");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "renewal_mandates" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "automatic_renewal_events" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "orders" DROP CONSTRAINT "orders_automatic_renewal_mandate_id_renewal_mandates_id_fk";
  ALTER TABLE "domain_expiry_reminders" DROP CONSTRAINT "domain_expiry_reminders_mandate_id_renewal_mandates_id_fk";
  DROP TABLE "automatic_renewal_events";
  DROP TABLE "renewal_mandates";
  ALTER TABLE "sms_challenges" ALTER COLUMN "step_up_purpose" SET DATA TYPE text;
  DROP TYPE "public"."enum_sms_challenges_step_up_purpose";
  CREATE TYPE "public"."enum_sms_challenges_step_up_purpose" AS ENUM('dns_record_change', 'nameserver_change', 'mx_record_change', 'dns_bulk_delete', 'domain_lock_change', 'realname_change', 'domain_management_password', 'balance_spend', 'account_deletion');
  ALTER TABLE "sms_challenges" ALTER COLUMN "step_up_purpose" SET DATA TYPE "public"."enum_sms_challenges_step_up_purpose" USING "step_up_purpose"::"public"."enum_sms_challenges_step_up_purpose";
  ALTER TABLE "step_up_grants" ALTER COLUMN "purpose" SET DATA TYPE text;
  DROP TYPE "public"."enum_step_up_grants_purpose";
  CREATE TYPE "public"."enum_step_up_grants_purpose" AS ENUM('dns_record_change', 'nameserver_change', 'mx_record_change', 'dns_bulk_delete', 'domain_lock_change', 'realname_change', 'domain_management_password', 'balance_spend', 'account_deletion');
  ALTER TABLE "step_up_grants" ALTER COLUMN "purpose" SET DATA TYPE "public"."enum_step_up_grants_purpose" USING "purpose"::"public"."enum_step_up_grants_purpose";
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'domainAssetSynchronization', 'walletLedgerConsistencyCheck', 'commerceFulfillment', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "orders_automatic_renewal_mandate_idx";
  DROP INDEX "orders_automatic_renewal_attempt_key_idx";
  DROP INDEX "orders_balance_hold_transaction_key_idx";
  DROP INDEX "domain_expiry_reminders_mandate_idx";
  DROP INDEX "asset_noticeType_expiresAtSnapshot_idx";
  ALTER TABLE "orders" DROP COLUMN "automatic_renewal_mandate_id";
  ALTER TABLE "orders" DROP COLUMN "automatic_renewal_attempt_key";
  ALTER TABLE "orders" DROP COLUMN "automatic_renewal_rules_version";
  ALTER TABLE "orders" DROP COLUMN "balance_hold_transaction_key";
  ALTER TABLE "domain_expiry_reminders" DROP COLUMN "notice_type";
  ALTER TABLE "domain_expiry_reminders" DROP COLUMN "mandate_id";
  ALTER TABLE "domain_expiry_reminders" DROP COLUMN "amount_fen";
  ALTER TABLE "domain_expiry_reminders" DROP COLUMN "authorized_max_amount_fen";
  DROP TYPE "public"."enum_domain_expiry_reminders_notice_type";
  DROP TYPE "public"."enum_renewal_mandates_scope";
  DROP TYPE "public"."enum_renewal_mandates_currency";
  DROP TYPE "public"."enum_renewal_mandates_event_type";
  DROP TYPE "public"."enum_automatic_renewal_events_event_type";`)
}
