import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_wallet_top_up_orders_payment_recovery_type" AS ENUM('provider_refund', 'dispute');
  CREATE TYPE "public"."enum_wallet_policy_versions_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_wallet_policy_versions_balance_expiration" AS ENUM('never');
  CREATE TYPE "public"."enum_wallet_policy_versions_financial_day_cut_timezone" AS ENUM('Asia/Shanghai');
  CREATE TYPE "public"."enum_wallet_policy_versions_statement_calculation" AS ENUM('ledger_entries_start_inclusive_end_exclusive');
  ALTER TYPE "public"."enum_wallet_transactions_type" ADD VALUE 'recovery';
  ALTER TYPE "public"."enum_wallet_entries_entry_type" ADD VALUE 'recovery';
  ALTER TYPE "public"."enum_provider_operations_target_type" ADD VALUE 'wallet_top_up';
  CREATE TABLE "wallet_policy_versions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"version" numeric NOT NULL,
  	"schema_version" numeric DEFAULT 1 NOT NULL,
  	"currency" "enum_wallet_policy_versions_currency" NOT NULL,
  	"balance_expiration" "enum_wallet_policy_versions_balance_expiration" NOT NULL,
  	"single_top_up_limit_fen" numeric NOT NULL,
  	"account_balance_limit_fen" numeric NOT NULL,
  	"single_spend_limit_fen" numeric NOT NULL,
  	"allow_negative_balance_recovery" boolean DEFAULT false NOT NULL,
  	"allow_restricted_account_emergency_renewal" boolean DEFAULT false NOT NULL,
  	"financial_day_cut_timezone" "enum_wallet_policy_versions_financial_day_cut_timezone" NOT NULL,
  	"statement_calculation" "enum_wallet_policy_versions_statement_calculation" NOT NULL,
  	"changed_by" varchar NOT NULL,
  	"change_note" varchar NOT NULL,
  	"effective_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_policy_versions_values_valid" CHECK (
	  "version" = trunc("version") AND "version" BETWEEN 1 AND 9007199254740991 AND
	  "schema_version" = 1 AND
	  "single_top_up_limit_fen" = trunc("single_top_up_limit_fen") AND
	  "single_top_up_limit_fen" >= 1 AND
	  "account_balance_limit_fen" = trunc("account_balance_limit_fen") AND
	  "account_balance_limit_fen" <= 9007199254740991 AND
	  "single_spend_limit_fen" = trunc("single_spend_limit_fen") AND
	  "single_spend_limit_fen" >= 1 AND
	  "single_top_up_limit_fen" <= "account_balance_limit_fen" AND
	  "single_spend_limit_fen" <= "account_balance_limit_fen" AND
	  length(trim("changed_by")) > 0 AND length(trim("change_note")) >= 8
	)
  );

  CREATE TABLE "wallet_policy_heads" (
	"singleton_key" varchar PRIMARY KEY NOT NULL,
	"current_version" numeric NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_policy_heads_singleton" CHECK ("singleton_key" = 'cny-wallet-funds-policy')
  );
  
  ALTER TABLE "refunds" ALTER COLUMN "order_id" DROP NOT NULL;
  ALTER TABLE "refunds" ADD COLUMN "wallet_top_up_order_id" integer;
  ALTER TABLE "refunds" ADD COLUMN "reason_code" varchar;
  ALTER TABLE "wallet_top_up_orders" ADD COLUMN "refunded_amount_fen" numeric;
  ALTER TABLE "wallet_top_up_orders" ADD COLUMN "payment_recovery_key" varchar;
  ALTER TABLE "wallet_top_up_orders" ADD COLUMN "payment_recovery_type" "enum_wallet_top_up_orders_payment_recovery_type";
  ALTER TABLE "wallet_top_up_orders" ADD COLUMN "payment_recovered_at" timestamp(3) with time zone;

  ALTER TABLE "wallet_transactions" DROP CONSTRAINT "wallet_transactions_state_valid";
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_state_valid" CHECK (
	("type"::text IN ('credit', 'recovery') AND "status"::text = 'posted' AND "resolved_at" IS NULL) OR
	("type"::text = 'hold' AND "status"::text = 'held' AND "resolved_at" IS NULL) OR
	("type"::text = 'hold' AND "status"::text IN ('captured', 'released') AND "resolved_at" IS NOT NULL)
  );
  ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_safe_integers";
  ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_safe_integers" CHECK (
	"amount_fen" = trunc("amount_fen") AND
	"amount_fen" BETWEEN 1 AND 9007199254740991 AND
	"ledger_sequence" = trunc("ledger_sequence") AND
	"ledger_sequence" BETWEEN 1 AND 9007199254740991 AND
	"posted_balance_after_fen" = trunc("posted_balance_after_fen") AND
	"posted_balance_after_fen" BETWEEN -9007199254740991 AND 9007199254740991 AND
	"held_balance_after_fen" = trunc("held_balance_after_fen") AND
	"held_balance_after_fen" BETWEEN 0 AND 9007199254740991 AND
	(
	  ("posted_balance_after_fen" > 0 AND "held_balance_after_fen" <= "posted_balance_after_fen") OR
	  "posted_balance_after_fen" <= 0
	)
  );

  ALTER TABLE "refunds" ADD CONSTRAINT "refunds_exactly_one_target" CHECK (
	("order_id" IS NOT NULL)::integer + ("wallet_top_up_order_id" IS NOT NULL)::integer = 1
  );
  ALTER TABLE "wallet_top_up_orders" DROP CONSTRAINT "wallet_top_up_orders_state_evidence_valid";
  ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_state_evidence_valid" CHECK (
	(
	  "status" = 'created' AND "payment_channel" IS NULL AND "payment_expires_at" IS NULL AND
	  "wechat_transaction_id" IS NULL AND "provider_paid_at" IS NULL AND
	  "provider_confirmed_at" IS NULL AND "credited_at" IS NULL AND
	  "original_refund_number" IS NULL AND "refunded_amount_fen" IS NULL AND
	  "payment_recovery_key" IS NULL AND "payment_recovery_type" IS NULL AND
	  "payment_recovered_at" IS NULL AND "refunded_at" IS NULL
	) OR (
	  "status" IN ('payment_pending', 'closed', 'unknown') AND "payment_channel" IS NOT NULL AND
	  "payment_expires_at" IS NOT NULL AND "wechat_transaction_id" IS NULL AND
	  "provider_paid_at" IS NULL AND "provider_confirmed_at" IS NULL AND
	  "credited_at" IS NULL AND "original_refund_number" IS NULL AND
	  "refunded_amount_fen" IS NULL AND "payment_recovery_key" IS NULL AND
	  "payment_recovery_type" IS NULL AND "payment_recovered_at" IS NULL AND "refunded_at" IS NULL
	) OR (
	  "status" = 'provider_confirmed' AND "payment_channel" IS NOT NULL AND
	  "payment_expires_at" IS NOT NULL AND "wechat_transaction_id" IS NOT NULL AND
	  "provider_paid_at" IS NOT NULL AND "provider_confirmed_at" IS NOT NULL AND
	  "credited_at" IS NULL AND "original_refund_number" IS NULL AND
	  "refunded_amount_fen" IS NULL AND "payment_recovery_key" IS NULL AND
	  "payment_recovery_type" IS NULL AND "payment_recovered_at" IS NULL AND "refunded_at" IS NULL
	) OR (
	  "status" = 'credited' AND "payment_channel" IS NOT NULL AND
	  "payment_expires_at" IS NOT NULL AND "wechat_transaction_id" IS NOT NULL AND
	  "provider_paid_at" IS NOT NULL AND "provider_confirmed_at" IS NOT NULL AND
	  "credited_at" IS NOT NULL AND "original_refund_number" IS NULL AND
	  "refunded_amount_fen" IS NULL AND "payment_recovery_key" IS NULL AND
	  "payment_recovery_type" IS NULL AND "payment_recovered_at" IS NULL AND "refunded_at" IS NULL
	) OR (
	  "status" = 'refund_pending' AND "payment_channel" IS NOT NULL AND
	  "payment_expires_at" IS NOT NULL AND "refunded_at" IS NULL AND
	  (
	    ("original_refund_number" IS NOT NULL AND "refunded_amount_fen" IS NOT NULL AND
	      "payment_recovery_key" IS NULL AND "payment_recovery_type" IS NULL AND "payment_recovered_at" IS NULL) OR
	    ("original_refund_number" IS NULL AND "refunded_amount_fen" IS NULL AND
	      "payment_recovery_key" IS NOT NULL AND "payment_recovery_type" IS NOT NULL AND "payment_recovered_at" IS NULL)
	  )
	) OR (
	  "status" = 'refunded' AND "payment_channel" IS NOT NULL AND
	  "payment_expires_at" IS NOT NULL AND "refunded_at" IS NOT NULL AND
	  (
	    ("original_refund_number" IS NOT NULL AND "refunded_amount_fen" IS NOT NULL AND
	      "payment_recovery_key" IS NULL AND "payment_recovery_type" IS NULL AND "payment_recovered_at" IS NULL) OR
	    ("original_refund_number" IS NULL AND "refunded_amount_fen" IS NULL AND
	      "payment_recovery_key" IS NOT NULL AND "payment_recovery_type" IS NOT NULL AND "payment_recovered_at" IS NOT NULL)
	  )
	)
  );
  ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_refund_amount_valid" CHECK (
	"refunded_amount_fen" IS NULL OR (
	  "refunded_amount_fen" = trunc("refunded_amount_fen") AND
	  "refunded_amount_fen" BETWEEN 1 AND "amount_fen"
	)
  );
  CREATE UNIQUE INDEX "wallet_policy_versions_version_idx" ON "wallet_policy_versions" USING btree ("version");
  CREATE INDEX "wallet_policy_versions_effective_at_idx" ON "wallet_policy_versions" USING btree ("effective_at");
  CREATE INDEX "wallet_policy_versions_updated_at_idx" ON "wallet_policy_versions" USING btree ("updated_at");
  CREATE INDEX "wallet_policy_versions_created_at_idx" ON "wallet_policy_versions" USING btree ("created_at");
  ALTER TABLE "wallet_policy_heads" ADD CONSTRAINT "wallet_policy_heads_current_version_fk"
	FOREIGN KEY ("current_version") REFERENCES "wallet_policy_versions"("version")
	DEFERRABLE INITIALLY DEFERRED;
  ALTER TABLE "refunds" ADD CONSTRAINT "refunds_wallet_top_up_order_id_wallet_top_up_orders_id_fk" FOREIGN KEY ("wallet_top_up_order_id") REFERENCES "public"."wallet_top_up_orders"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "refunds_wallet_top_up_order_idx" ON "refunds" USING btree ("wallet_top_up_order_id");
  CREATE INDEX "refunds_reason_code_idx" ON "refunds" USING btree ("reason_code");
  CREATE UNIQUE INDEX "wallet_top_up_orders_payment_recovery_key_idx" ON "wallet_top_up_orders" USING btree ("payment_recovery_key");

  INSERT INTO "wallet_policy_versions" (
	"version", "schema_version", "currency", "balance_expiration",
	"single_top_up_limit_fen", "account_balance_limit_fen", "single_spend_limit_fen",
	"allow_negative_balance_recovery", "allow_restricted_account_emergency_renewal",
	"financial_day_cut_timezone", "statement_calculation", "changed_by", "change_note", "effective_at"
  ) VALUES (
	1, 1, 'CNY', 'never', 5000000, 10000000, 3000000, true, false,
	'Asia/Shanghai', 'ledger_entries_start_inclusive_end_exclusive',
	'system:migration', 'D9-B-4 initial wallet funds policy', NOW()
  );
  INSERT INTO "wallet_policy_heads" ("singleton_key", "current_version")
  VALUES ('cny-wallet-funds-policy', 1);`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DO $$
  BEGIN
    IF (SELECT COUNT(*) FROM "wallet_policy_versions") <> 1 OR
       NOT EXISTS (
         SELECT 1 FROM "wallet_policy_versions"
         WHERE "version" = 1 AND "changed_by" = 'system:migration'
       ) OR
       EXISTS (SELECT 1 FROM "refunds" WHERE "wallet_top_up_order_id" IS NOT NULL OR "reason_code" IS NOT NULL) OR
       EXISTS (SELECT 1 FROM "wallet_transactions" WHERE "type"::text = 'recovery') OR
       EXISTS (SELECT 1 FROM "wallet_entries" WHERE "entry_type"::text = 'recovery') OR
       EXISTS (SELECT 1 FROM "provider_operations" WHERE "target_type"::text = 'wallet_top_up') OR
       EXISTS (
         SELECT 1 FROM "wallet_top_up_orders"
         WHERE "refunded_amount_fen" IS NOT NULL OR "payment_recovery_key" IS NOT NULL OR
               "payment_recovery_type" IS NOT NULL OR "payment_recovered_at" IS NOT NULL
       ) THEN
      RAISE EXCEPTION 'D9-B-4 down migration refused: wallet funds policy data exists';
    END IF;
  END $$;
  DROP TABLE "wallet_policy_heads";
  `)
  await db.execute(sql`
   ALTER TABLE "wallet_policy_versions" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "wallet_policy_versions" CASCADE;
  ALTER TABLE "refunds" DROP CONSTRAINT "refunds_wallet_top_up_order_id_wallet_top_up_orders_id_fk";
  
  ALTER TABLE "wallet_transactions" DROP CONSTRAINT "wallet_transactions_state_valid";
  ALTER TABLE "wallet_transactions" ALTER COLUMN "type" SET DATA TYPE text;
  DROP TYPE "public"."enum_wallet_transactions_type";
  CREATE TYPE "public"."enum_wallet_transactions_type" AS ENUM('credit', 'hold');
  ALTER TABLE "wallet_transactions" ALTER COLUMN "type" SET DATA TYPE "public"."enum_wallet_transactions_type" USING "type"::"public"."enum_wallet_transactions_type";
  ALTER TABLE "wallet_entries" ALTER COLUMN "entry_type" SET DATA TYPE text;
  DROP TYPE "public"."enum_wallet_entries_entry_type";
  CREATE TYPE "public"."enum_wallet_entries_entry_type" AS ENUM('credit', 'hold', 'capture', 'release');
  ALTER TABLE "wallet_entries" ALTER COLUMN "entry_type" SET DATA TYPE "public"."enum_wallet_entries_entry_type" USING "entry_type"::"public"."enum_wallet_entries_entry_type";
  ALTER TABLE "provider_operations" ALTER COLUMN "target_type" SET DATA TYPE text;
  DROP TYPE "public"."enum_provider_operations_target_type";
  CREATE TYPE "public"."enum_provider_operations_target_type" AS ENUM('order', 'realname_template', 'domain');
  ALTER TABLE "provider_operations" ALTER COLUMN "target_type" SET DATA TYPE "public"."enum_provider_operations_target_type" USING "target_type"::"public"."enum_provider_operations_target_type";
  ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_state_valid" CHECK (
	("type" = 'credit' AND "status" = 'posted' AND "resolved_at" IS NULL) OR
	("type" = 'hold' AND "status" = 'held' AND "resolved_at" IS NULL) OR
	("type" = 'hold' AND "status" IN ('captured', 'released') AND "resolved_at" IS NOT NULL)
  );
  ALTER TABLE "wallet_entries" DROP CONSTRAINT "wallet_entries_safe_integers";
  ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_safe_integers" CHECK (
	"amount_fen" = trunc("amount_fen") AND "amount_fen" BETWEEN 1 AND 9007199254740991 AND
	"ledger_sequence" = trunc("ledger_sequence") AND "ledger_sequence" BETWEEN 1 AND 9007199254740991 AND
	"posted_balance_after_fen" = trunc("posted_balance_after_fen") AND
	"posted_balance_after_fen" <= 9007199254740991 AND
	"held_balance_after_fen" = trunc("held_balance_after_fen") AND
	"held_balance_after_fen" >= 0 AND "held_balance_after_fen" <= "posted_balance_after_fen"
  );
  ALTER TABLE "refunds" DROP CONSTRAINT "refunds_exactly_one_target";
  ALTER TABLE "wallet_top_up_orders" DROP CONSTRAINT "wallet_top_up_orders_refund_amount_valid";
  ALTER TABLE "wallet_top_up_orders" DROP CONSTRAINT "wallet_top_up_orders_state_evidence_valid";
  ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_state_evidence_valid" CHECK (
	("status" = 'created' AND "payment_channel" IS NULL AND "payment_expires_at" IS NULL AND "wechat_transaction_id" IS NULL AND "provider_paid_at" IS NULL AND "provider_confirmed_at" IS NULL AND "credited_at" IS NULL AND "original_refund_number" IS NULL AND "refunded_at" IS NULL) OR
	("status" IN ('payment_pending', 'closed', 'unknown') AND "payment_channel" IS NOT NULL AND "payment_expires_at" IS NOT NULL AND "wechat_transaction_id" IS NULL AND "provider_paid_at" IS NULL AND "provider_confirmed_at" IS NULL AND "credited_at" IS NULL AND "original_refund_number" IS NULL AND "refunded_at" IS NULL) OR
	("status" = 'provider_confirmed' AND "payment_channel" IS NOT NULL AND "payment_expires_at" IS NOT NULL AND "wechat_transaction_id" IS NOT NULL AND "provider_paid_at" IS NOT NULL AND "provider_confirmed_at" IS NOT NULL AND "credited_at" IS NULL AND "original_refund_number" IS NULL AND "refunded_at" IS NULL) OR
	("status" = 'credited' AND "payment_channel" IS NOT NULL AND "payment_expires_at" IS NOT NULL AND "wechat_transaction_id" IS NOT NULL AND "provider_paid_at" IS NOT NULL AND "provider_confirmed_at" IS NOT NULL AND "credited_at" IS NOT NULL AND "original_refund_number" IS NULL AND "refunded_at" IS NULL) OR
	("status" = 'refund_pending' AND "payment_channel" IS NOT NULL AND "payment_expires_at" IS NOT NULL AND "original_refund_number" IS NOT NULL AND "refunded_at" IS NULL) OR
	("status" = 'refunded' AND "payment_channel" IS NOT NULL AND "payment_expires_at" IS NOT NULL AND "original_refund_number" IS NOT NULL AND "refunded_at" IS NOT NULL)
  );
  DROP INDEX "refunds_wallet_top_up_order_idx";
  DROP INDEX "refunds_reason_code_idx";
  DROP INDEX "wallet_top_up_orders_payment_recovery_key_idx";
  ALTER TABLE "refunds" ALTER COLUMN "order_id" SET NOT NULL;
  ALTER TABLE "refunds" DROP COLUMN "wallet_top_up_order_id";
  ALTER TABLE "refunds" DROP COLUMN "reason_code";
  ALTER TABLE "wallet_top_up_orders" DROP COLUMN "refunded_amount_fen";
  ALTER TABLE "wallet_top_up_orders" DROP COLUMN "payment_recovery_key";
  ALTER TABLE "wallet_top_up_orders" DROP COLUMN "payment_recovery_type";
  ALTER TABLE "wallet_top_up_orders" DROP COLUMN "payment_recovered_at";
  DROP TYPE "public"."enum_wallet_top_up_orders_payment_recovery_type";
  DROP TYPE "public"."enum_wallet_policy_versions_currency";
  DROP TYPE "public"."enum_wallet_policy_versions_balance_expiration";
  DROP TYPE "public"."enum_wallet_policy_versions_financial_day_cut_timezone";
  DROP TYPE "public"."enum_wallet_policy_versions_statement_calculation";`)
}
