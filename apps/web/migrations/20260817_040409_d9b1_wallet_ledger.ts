import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_wallet_accounts_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_wallet_transactions_type" AS ENUM('credit', 'hold');
  CREATE TYPE "public"."enum_wallet_transactions_status" AS ENUM('posted', 'held', 'captured', 'released');
  CREATE TYPE "public"."enum_wallet_entries_entry_type" AS ENUM('credit', 'hold', 'capture', 'release');
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'walletLedgerConsistencyCheck' BEFORE 'commerceFulfillment';
  CREATE TABLE "wallet_accounts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
   	"currency" "enum_wallet_accounts_currency" NOT NULL,
   	"ledger_version" numeric DEFAULT 0 NOT NULL,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
		CONSTRAINT "wallet_accounts_ledger_version_safe_integer" CHECK (
		  "ledger_version" = trunc("ledger_version") AND
		  "ledger_version" >= 0 AND
		  "ledger_version" <= 9007199254740991
	)
  );
  
  CREATE TABLE "wallet_transactions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"transaction_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"account_id" integer NOT NULL,
  	"type" "enum_wallet_transactions_type" NOT NULL,
  	"status" "enum_wallet_transactions_status" NOT NULL,
  	"amount_fen" numeric NOT NULL,
   	"resolved_at" timestamp(3) with time zone,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
		CONSTRAINT "wallet_transactions_amount_safe_integer" CHECK (
		  "amount_fen" = trunc("amount_fen") AND
		  "amount_fen" >= 1 AND
		  "amount_fen" <= 9007199254740991
	),
	CONSTRAINT "wallet_transactions_state_valid" CHECK (
	  ("type" = 'credit' AND "status" = 'posted' AND "resolved_at" IS NULL) OR
	  ("type" = 'hold' AND "status" = 'held' AND "resolved_at" IS NULL) OR
	  ("type" = 'hold' AND "status" IN ('captured', 'released') AND "resolved_at" IS NOT NULL)
	)
  );
  
  CREATE TABLE "wallet_entries" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"entry_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"account_id" integer NOT NULL,
  	"transaction_id" integer NOT NULL,
  	"entry_type" "enum_wallet_entries_entry_type" NOT NULL,
  	"amount_fen" numeric NOT NULL,
  	"ledger_sequence" numeric NOT NULL,
  	"posted_balance_after_fen" numeric NOT NULL,
   	"held_balance_after_fen" numeric NOT NULL,
   	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
		CONSTRAINT "wallet_entries_safe_integers" CHECK (
		  "amount_fen" = trunc("amount_fen") AND
		  "amount_fen" >= 1 AND
		  "amount_fen" <= 9007199254740991 AND
		  "ledger_sequence" = trunc("ledger_sequence") AND
		  "ledger_sequence" >= 1 AND
		  "ledger_sequence" <= 9007199254740991 AND
		  "posted_balance_after_fen" = trunc("posted_balance_after_fen") AND
		  "posted_balance_after_fen" <= 9007199254740991 AND
		  "held_balance_after_fen" = trunc("held_balance_after_fen") AND
		  "held_balance_after_fen" >= 0 AND
	  "held_balance_after_fen" <= "posted_balance_after_fen"
	)
  );
  
  ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_account_id_wallet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_account_id_wallet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_transaction_id_wallet_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."wallet_transactions"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "wallet_accounts_customer_idx" ON "wallet_accounts" USING btree ("customer_id");
  CREATE INDEX "wallet_accounts_updated_at_idx" ON "wallet_accounts" USING btree ("updated_at");
  CREATE INDEX "wallet_accounts_created_at_idx" ON "wallet_accounts" USING btree ("created_at");
  CREATE UNIQUE INDEX "customer_currency_idx" ON "wallet_accounts" USING btree ("customer_id","currency");
  CREATE UNIQUE INDEX "wallet_transactions_transaction_key_idx" ON "wallet_transactions" USING btree ("transaction_key");
  CREATE INDEX "wallet_transactions_customer_idx" ON "wallet_transactions" USING btree ("customer_id");
  CREATE INDEX "wallet_transactions_account_idx" ON "wallet_transactions" USING btree ("account_id");
  CREATE INDEX "wallet_transactions_status_idx" ON "wallet_transactions" USING btree ("status");
  CREATE INDEX "wallet_transactions_resolved_at_idx" ON "wallet_transactions" USING btree ("resolved_at");
  CREATE INDEX "wallet_transactions_updated_at_idx" ON "wallet_transactions" USING btree ("updated_at");
  CREATE INDEX "wallet_transactions_created_at_idx" ON "wallet_transactions" USING btree ("created_at");
  CREATE INDEX "account_status_idx" ON "wallet_transactions" USING btree ("account_id","status");
  CREATE UNIQUE INDEX "wallet_entries_entry_key_idx" ON "wallet_entries" USING btree ("entry_key");
  CREATE INDEX "wallet_entries_customer_idx" ON "wallet_entries" USING btree ("customer_id");
  CREATE INDEX "wallet_entries_account_idx" ON "wallet_entries" USING btree ("account_id");
  CREATE INDEX "wallet_entries_transaction_idx" ON "wallet_entries" USING btree ("transaction_id");
  CREATE INDEX "wallet_entries_updated_at_idx" ON "wallet_entries" USING btree ("updated_at");
  CREATE INDEX "wallet_entries_created_at_idx" ON "wallet_entries" USING btree ("created_at");
  CREATE UNIQUE INDEX "account_ledgerSequence_idx" ON "wallet_entries" USING btree ("account_id","ledger_sequence");
  CREATE INDEX "account_createdAt_idx" ON "wallet_entries" USING btree ("account_id","created_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DELETE FROM "payload_jobs" WHERE "workflow_slug"::text = 'walletLedgerConsistencyCheck';`)
  await db.execute(sql`
   DROP TABLE "wallet_accounts" CASCADE;
  DROP TABLE "wallet_transactions" CASCADE;
  DROP TABLE "wallet_entries" CASCADE;
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'commerceFulfillment', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP TYPE "public"."enum_wallet_accounts_currency";
  DROP TYPE "public"."enum_wallet_transactions_type";
  DROP TYPE "public"."enum_wallet_transactions_status";
  DROP TYPE "public"."enum_wallet_entries_entry_type";`)
}
