import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_points_batches_source_type" AS ENUM('order_reward');
  CREATE TYPE "public"."enum_points_redemptions_target" AS ENUM('advanced_whois', 'bulk_query', 'ai_domain_analysis');
  CREATE TYPE "public"."enum_points_ledger_entry_type" AS ENUM('pending', 'available', 'held', 'consumed', 'expired', 'reversed');
  CREATE TYPE "public"."enum_tool_quota_ledger_target" AS ENUM('advanced_whois', 'bulk_query', 'ai_domain_analysis');
  CREATE TYPE "public"."enum_tool_quota_ledger_entry_type" AS ENUM('grant', 'consume');
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'pointsExpiration' BEFORE 'notificationDelivery';
  CREATE TABLE "points_accounts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"ledger_version" numeric DEFAULT 0 NOT NULL,
	"quota_ledger_version" numeric DEFAULT 0 NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_accounts_versions_safe_integer" CHECK (
	  "ledger_version" = trunc("ledger_version") AND
	  "ledger_version" BETWEEN 0 AND 9007199254740991 AND
	  "quota_ledger_version" = trunc("quota_ledger_version") AND
	  "quota_ledger_version" BETWEEN 0 AND 9007199254740991
	)
  );
  
  CREATE TABLE "points_batches" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"earning_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"account_id" integer NOT NULL,
  	"source_type" "enum_points_batches_source_type" NOT NULL,
  	"source_order_id" integer NOT NULL,
  	"points" numeric NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_batches_points_safe_integer" CHECK (
	  "points" = trunc("points") AND "points" BETWEEN 1 AND 9007199254740991
	),
	CONSTRAINT "points_batches_expiry_after_creation" CHECK ("expires_at" > "created_at")
  );
  
  CREATE TABLE "points_redemptions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"redemption_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"account_id" integer NOT NULL,
  	"target" "enum_points_redemptions_target" NOT NULL,
  	"points_cost" numeric NOT NULL,
	"quota_units" numeric NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_redemptions_amounts_safe_integer" CHECK (
	  "points_cost" = trunc("points_cost") AND
	  "points_cost" BETWEEN 1 AND 9007199254740991 AND
	  "quota_units" = trunc("quota_units") AND
	  "quota_units" BETWEEN 1 AND 9007199254740991
	)
  );
  
  CREATE TABLE "points_ledger" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"entry_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"account_id" integer NOT NULL,
  	"batch_id" integer NOT NULL,
  	"redemption_id" integer,
  	"entry_type" "enum_points_ledger_entry_type" NOT NULL,
  	"points" numeric NOT NULL,
	"ledger_sequence" numeric NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_ledger_values_safe_integer" CHECK (
	  "points" = trunc("points") AND "points" BETWEEN 1 AND 9007199254740991 AND
	  "ledger_sequence" = trunc("ledger_sequence") AND
	  "ledger_sequence" BETWEEN 1 AND 9007199254740991
	),
	CONSTRAINT "points_ledger_state_links_valid" CHECK (
	  ("entry_type" IN ('pending', 'available', 'expired', 'reversed') AND "redemption_id" IS NULL) OR
	  ("entry_type" IN ('held', 'consumed') AND "redemption_id" IS NOT NULL)
	)
  );
  
  CREATE TABLE "points_consumption_allocations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"allocation_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"account_id" integer NOT NULL,
  	"redemption_id" integer NOT NULL,
  	"batch_id" integer NOT NULL,
	"points" numeric NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "points_allocations_points_safe_integer" CHECK (
	  "points" = trunc("points") AND "points" BETWEEN 1 AND 9007199254740991
	)
  );
  
  CREATE TABLE "tool_quota_ledger" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"entry_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"account_id" integer NOT NULL,
  	"redemption_id" integer,
  	"target" "enum_tool_quota_ledger_target" NOT NULL,
  	"entry_type" "enum_tool_quota_ledger_entry_type" NOT NULL,
  	"quota_units" numeric NOT NULL,
	"ledger_sequence" numeric NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_quota_ledger_values_safe_integer" CHECK (
	  "quota_units" = trunc("quota_units") AND
	  "quota_units" BETWEEN 1 AND 9007199254740991 AND
	  "ledger_sequence" = trunc("ledger_sequence") AND
	  "ledger_sequence" BETWEEN 1 AND 9007199254740991
	),
	CONSTRAINT "tool_quota_ledger_state_links_valid" CHECK (
	  ("entry_type" = 'grant' AND "redemption_id" IS NOT NULL) OR
	  ("entry_type" = 'consume' AND "redemption_id" IS NULL)
	)
  );
  
  ALTER TABLE "points_accounts" ADD CONSTRAINT "points_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_batches" ADD CONSTRAINT "points_batches_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_batches" ADD CONSTRAINT "points_batches_account_id_points_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."points_accounts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_batches" ADD CONSTRAINT "points_batches_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_redemptions" ADD CONSTRAINT "points_redemptions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_redemptions" ADD CONSTRAINT "points_redemptions_account_id_points_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."points_accounts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_account_id_points_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."points_accounts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_batch_id_points_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."points_batches"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_ledger" ADD CONSTRAINT "points_ledger_redemption_id_points_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."points_redemptions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_consumption_allocations" ADD CONSTRAINT "points_consumption_allocations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_consumption_allocations" ADD CONSTRAINT "points_consumption_allocations_account_id_points_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."points_accounts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_consumption_allocations" ADD CONSTRAINT "points_consumption_allocations_redemption_id_points_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."points_redemptions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "points_consumption_allocations" ADD CONSTRAINT "points_consumption_allocations_batch_id_points_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."points_batches"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tool_quota_ledger" ADD CONSTRAINT "tool_quota_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tool_quota_ledger" ADD CONSTRAINT "tool_quota_ledger_account_id_points_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."points_accounts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tool_quota_ledger" ADD CONSTRAINT "tool_quota_ledger_redemption_id_points_redemptions_id_fk" FOREIGN KEY ("redemption_id") REFERENCES "public"."points_redemptions"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "points_accounts_customer_idx" ON "points_accounts" USING btree ("customer_id");
  CREATE INDEX "points_accounts_updated_at_idx" ON "points_accounts" USING btree ("updated_at");
  CREATE INDEX "points_accounts_created_at_idx" ON "points_accounts" USING btree ("created_at");
  CREATE UNIQUE INDEX "customer_idx" ON "points_accounts" USING btree ("customer_id");
  CREATE UNIQUE INDEX "points_batches_earning_key_idx" ON "points_batches" USING btree ("earning_key");
  CREATE INDEX "points_batches_customer_idx" ON "points_batches" USING btree ("customer_id");
  CREATE INDEX "points_batches_account_idx" ON "points_batches" USING btree ("account_id");
  CREATE INDEX "points_batches_source_order_idx" ON "points_batches" USING btree ("source_order_id");
  CREATE INDEX "points_batches_expires_at_idx" ON "points_batches" USING btree ("expires_at");
  CREATE INDEX "points_batches_updated_at_idx" ON "points_batches" USING btree ("updated_at");
  CREATE INDEX "points_batches_created_at_idx" ON "points_batches" USING btree ("created_at");
  CREATE INDEX "account_expiresAt_idx" ON "points_batches" USING btree ("account_id","expires_at");
  CREATE INDEX "customer_expiresAt_1_idx" ON "points_batches" USING btree ("customer_id","expires_at");
  CREATE UNIQUE INDEX "points_redemptions_redemption_key_idx" ON "points_redemptions" USING btree ("redemption_key");
  CREATE INDEX "points_redemptions_customer_idx" ON "points_redemptions" USING btree ("customer_id");
  CREATE INDEX "points_redemptions_account_idx" ON "points_redemptions" USING btree ("account_id");
  CREATE INDEX "points_redemptions_updated_at_idx" ON "points_redemptions" USING btree ("updated_at");
  CREATE INDEX "points_redemptions_created_at_idx" ON "points_redemptions" USING btree ("created_at");
  CREATE INDEX "account_createdAt_1_idx" ON "points_redemptions" USING btree ("account_id","created_at");
  CREATE UNIQUE INDEX "points_ledger_entry_key_idx" ON "points_ledger" USING btree ("entry_key");
  CREATE INDEX "points_ledger_customer_idx" ON "points_ledger" USING btree ("customer_id");
  CREATE INDEX "points_ledger_account_idx" ON "points_ledger" USING btree ("account_id");
  CREATE INDEX "points_ledger_batch_idx" ON "points_ledger" USING btree ("batch_id");
  CREATE INDEX "points_ledger_redemption_idx" ON "points_ledger" USING btree ("redemption_id");
  CREATE INDEX "points_ledger_updated_at_idx" ON "points_ledger" USING btree ("updated_at");
  CREATE INDEX "points_ledger_created_at_idx" ON "points_ledger" USING btree ("created_at");
  CREATE UNIQUE INDEX "account_ledgerSequence_1_idx" ON "points_ledger" USING btree ("account_id","ledger_sequence");
  CREATE INDEX "batch_entryType_idx" ON "points_ledger" USING btree ("batch_id","entry_type");
  CREATE INDEX "redemption_entryType_idx" ON "points_ledger" USING btree ("redemption_id","entry_type");
  CREATE UNIQUE INDEX "points_consumption_allocations_allocation_key_idx" ON "points_consumption_allocations" USING btree ("allocation_key");
  CREATE INDEX "points_consumption_allocations_customer_idx" ON "points_consumption_allocations" USING btree ("customer_id");
  CREATE INDEX "points_consumption_allocations_account_idx" ON "points_consumption_allocations" USING btree ("account_id");
  CREATE INDEX "points_consumption_allocations_redemption_idx" ON "points_consumption_allocations" USING btree ("redemption_id");
  CREATE INDEX "points_consumption_allocations_batch_idx" ON "points_consumption_allocations" USING btree ("batch_id");
  CREATE INDEX "points_consumption_allocations_updated_at_idx" ON "points_consumption_allocations" USING btree ("updated_at");
  CREATE INDEX "points_consumption_allocations_created_at_idx" ON "points_consumption_allocations" USING btree ("created_at");
  CREATE UNIQUE INDEX "redemption_batch_idx" ON "points_consumption_allocations" USING btree ("redemption_id","batch_id");
  CREATE UNIQUE INDEX "tool_quota_ledger_entry_key_idx" ON "tool_quota_ledger" USING btree ("entry_key");
  CREATE INDEX "tool_quota_ledger_customer_idx" ON "tool_quota_ledger" USING btree ("customer_id");
  CREATE INDEX "tool_quota_ledger_account_idx" ON "tool_quota_ledger" USING btree ("account_id");
  CREATE INDEX "tool_quota_ledger_redemption_idx" ON "tool_quota_ledger" USING btree ("redemption_id");
  CREATE INDEX "tool_quota_ledger_updated_at_idx" ON "tool_quota_ledger" USING btree ("updated_at");
  CREATE INDEX "tool_quota_ledger_created_at_idx" ON "tool_quota_ledger" USING btree ("created_at");
  CREATE UNIQUE INDEX "account_ledgerSequence_2_idx" ON "tool_quota_ledger" USING btree ("account_id","ledger_sequence");
  CREATE INDEX "account_target_createdAt_idx" ON "tool_quota_ledger" USING btree ("account_id","target","created_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DELETE FROM "payload_jobs" WHERE "workflow_slug"::text = 'pointsExpiration';`)
  await db.execute(sql`
   DROP TABLE "points_accounts" CASCADE;
  DROP TABLE "points_batches" CASCADE;
  DROP TABLE "points_redemptions" CASCADE;
  DROP TABLE "points_ledger" CASCADE;
  DROP TABLE "points_consumption_allocations" CASCADE;
  DROP TABLE "tool_quota_ledger" CASCADE;
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'domainAssetSynchronization', 'walletLedgerConsistencyCheck', 'notificationDelivery', 'commerceFulfillment', 'automaticRenewalScheduling', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP TYPE "public"."enum_points_batches_source_type";
  DROP TYPE "public"."enum_points_redemptions_target";
  DROP TYPE "public"."enum_points_ledger_entry_type";
  DROP TYPE "public"."enum_tool_quota_ledger_target";
  DROP TYPE "public"."enum_tool_quota_ledger_entry_type";`)
}
