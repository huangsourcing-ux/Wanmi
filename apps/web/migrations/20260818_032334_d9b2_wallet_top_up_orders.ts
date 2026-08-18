import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_wallet_top_up_orders_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_wallet_top_up_orders_funding_source" AS ENUM('wechat');
  CREATE TYPE "public"."enum_wallet_top_up_orders_payment_channel" AS ENUM('native', 'h5');
  CREATE TYPE "public"."enum_wallet_top_up_orders_status" AS ENUM('created', 'payment_pending', 'provider_confirmed', 'credited', 'refund_pending', 'refunded', 'closed', 'unknown');
  CREATE TABLE "wallet_top_up_orders" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"top_up_order_number" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"account_id" integer NOT NULL,
  	"amount_fen" numeric NOT NULL,
  	"currency" "enum_wallet_top_up_orders_currency" NOT NULL,
  	"funding_source" "enum_wallet_top_up_orders_funding_source" NOT NULL,
  	"payment_channel" "enum_wallet_top_up_orders_payment_channel",
  	"status" "enum_wallet_top_up_orders_status" DEFAULT 'created' NOT NULL,
  	"wechat_transaction_id" varchar,
  	"ledger_transaction_key" varchar NOT NULL,
  	"original_refund_number" varchar,
  	"payment_expires_at" timestamp(3) with time zone,
  	"provider_paid_at" timestamp(3) with time zone,
  	"provider_confirmed_at" timestamp(3) with time zone,
  	"credited_at" timestamp(3) with time zone,
	"refunded_at" timestamp(3) with time zone,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_top_up_orders_amount_safe_integer" CHECK (
	  "amount_fen" = trunc("amount_fen") AND
	  "amount_fen" >= 1 AND
	  "amount_fen" <= 9007199254740991
	),
	CONSTRAINT "wallet_top_up_orders_identifiers_valid" CHECK (
	  "top_up_order_number" ~ '^WT[0-9a-f]{30}$' AND
	  length(trim("ledger_transaction_key")) > 0 AND
	  ("wechat_transaction_id" IS NULL OR length(trim("wechat_transaction_id")) > 0) AND
	  ("original_refund_number" IS NULL OR length(trim("original_refund_number")) > 0)
	),
	CONSTRAINT "wallet_top_up_orders_state_evidence_valid" CHECK (
	  (
	    "status" = 'created' AND
	    "payment_channel" IS NULL AND
	    "payment_expires_at" IS NULL AND
	    "wechat_transaction_id" IS NULL AND
	    "provider_paid_at" IS NULL AND
	    "provider_confirmed_at" IS NULL AND
	    "credited_at" IS NULL AND
	    "original_refund_number" IS NULL AND
	    "refunded_at" IS NULL
	  ) OR (
	    "status" IN ('payment_pending', 'closed', 'unknown') AND
	    "payment_channel" IS NOT NULL AND
	    "payment_expires_at" IS NOT NULL AND
	    "wechat_transaction_id" IS NULL AND
	    "provider_paid_at" IS NULL AND
	    "provider_confirmed_at" IS NULL AND
	    "credited_at" IS NULL AND
	    "original_refund_number" IS NULL AND
	    "refunded_at" IS NULL
	  ) OR (
	    "status" = 'provider_confirmed' AND
	    "payment_channel" IS NOT NULL AND
	    "payment_expires_at" IS NOT NULL AND
	    "wechat_transaction_id" IS NOT NULL AND
	    "provider_paid_at" IS NOT NULL AND
	    "provider_confirmed_at" IS NOT NULL AND
	    "credited_at" IS NULL AND
	    "original_refund_number" IS NULL AND
	    "refunded_at" IS NULL
	  ) OR (
	    "status" = 'credited' AND
	    "payment_channel" IS NOT NULL AND
	    "payment_expires_at" IS NOT NULL AND
	    "wechat_transaction_id" IS NOT NULL AND
	    "provider_paid_at" IS NOT NULL AND
	    "provider_confirmed_at" IS NOT NULL AND
	    "credited_at" IS NOT NULL AND
	    "original_refund_number" IS NULL AND
	    "refunded_at" IS NULL
	  ) OR (
	    "status" = 'refund_pending' AND
	    "payment_channel" IS NOT NULL AND
	    "payment_expires_at" IS NOT NULL AND
	    "original_refund_number" IS NOT NULL AND
	    "refunded_at" IS NULL
	  ) OR (
	    "status" = 'refunded' AND
	    "payment_channel" IS NOT NULL AND
	    "payment_expires_at" IS NOT NULL AND
	    "original_refund_number" IS NOT NULL AND
	    "refunded_at" IS NOT NULL
	  )
	)
  );
  
  ALTER TABLE "payment_notification_archives" ADD COLUMN "wallet_top_up_order_id" integer;
  ALTER TABLE "manual_reviews" ADD COLUMN "wallet_top_up_order_id" integer;
  ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_account_id_wallet_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "wallet_top_up_orders_top_up_order_number_idx" ON "wallet_top_up_orders" USING btree ("top_up_order_number");
  CREATE INDEX "wallet_top_up_orders_customer_idx" ON "wallet_top_up_orders" USING btree ("customer_id");
  CREATE INDEX "wallet_top_up_orders_account_idx" ON "wallet_top_up_orders" USING btree ("account_id");
  CREATE INDEX "wallet_top_up_orders_status_idx" ON "wallet_top_up_orders" USING btree ("status");
  CREATE UNIQUE INDEX "wallet_top_up_orders_wechat_transaction_id_idx" ON "wallet_top_up_orders" USING btree ("wechat_transaction_id");
  CREATE UNIQUE INDEX "wallet_top_up_orders_ledger_transaction_key_idx" ON "wallet_top_up_orders" USING btree ("ledger_transaction_key");
  CREATE UNIQUE INDEX "wallet_top_up_orders_original_refund_number_idx" ON "wallet_top_up_orders" USING btree ("original_refund_number");
  CREATE INDEX "wallet_top_up_orders_updated_at_idx" ON "wallet_top_up_orders" USING btree ("updated_at");
  CREATE INDEX "wallet_top_up_orders_created_at_idx" ON "wallet_top_up_orders" USING btree ("created_at");
  CREATE INDEX "customer_createdAt_idx" ON "wallet_top_up_orders" USING btree ("customer_id","created_at");
  CREATE INDEX "account_status_1_idx" ON "wallet_top_up_orders" USING btree ("account_id","status");
  ALTER TABLE "payment_notification_archives" ADD CONSTRAINT "payment_notification_archives_wallet_top_up_order_id_wallet_top_up_orders_id_fk" FOREIGN KEY ("wallet_top_up_order_id") REFERENCES "public"."wallet_top_up_orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_wallet_top_up_order_id_wallet_top_up_orders_id_fk" FOREIGN KEY ("wallet_top_up_order_id") REFERENCES "public"."wallet_top_up_orders"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "payment_notification_archives_wallet_top_up_order_idx" ON "payment_notification_archives" USING btree ("wallet_top_up_order_id");
  CREATE INDEX "manual_reviews_wallet_top_up_order_idx" ON "manual_reviews" USING btree ("wallet_top_up_order_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payment_notification_archives" DROP CONSTRAINT "payment_notification_archives_wallet_top_up_order_id_wallet_top_up_orders_id_fk";
  
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_wallet_top_up_order_id_wallet_top_up_orders_id_fk";
  
  DROP INDEX "payment_notification_archives_wallet_top_up_order_idx";
  DROP INDEX "manual_reviews_wallet_top_up_order_idx";
  ALTER TABLE "payment_notification_archives" DROP COLUMN "wallet_top_up_order_id";
  ALTER TABLE "manual_reviews" DROP COLUMN "wallet_top_up_order_id";
  ALTER TABLE "wallet_top_up_orders" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "wallet_top_up_orders" CASCADE;
  DROP TYPE "public"."enum_wallet_top_up_orders_currency";
  DROP TYPE "public"."enum_wallet_top_up_orders_funding_source";
  DROP TYPE "public"."enum_wallet_top_up_orders_payment_channel";
  DROP TYPE "public"."enum_wallet_top_up_orders_status";`)
}
