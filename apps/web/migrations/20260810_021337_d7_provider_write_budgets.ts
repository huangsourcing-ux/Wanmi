import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_provider_write_budgets_provider" AS ENUM('westdigital', 'wechatpay');
  CREATE TYPE "public"."enum_provider_write_budgets_capability" AS ENUM('register_renew', 'payment', 'refund');
  CREATE TABLE "provider_write_budgets" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"scope_key" varchar NOT NULL,
  	"provider" "enum_provider_write_budgets_provider" NOT NULL,
  	"capability" "enum_provider_write_budgets_capability" NOT NULL,
  	"used_operations" numeric DEFAULT 0 NOT NULL,
  	"used_amount_fen" numeric DEFAULT 0 NOT NULL,
  	"configured_operation_limit" numeric DEFAULT 0 NOT NULL,
  	"configured_amount_limit_fen" numeric DEFAULT 0 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_write_budgets_scope_match" CHECK (
	  ("provider" = 'westdigital' AND "capability" = 'register_renew') OR
	  ("provider" = 'wechatpay' AND "capability" IN ('payment', 'refund'))
	),
	CONSTRAINT "provider_write_budgets_safe_integers" CHECK (
	  "used_operations" = trunc("used_operations") AND
	  "used_operations" BETWEEN 0 AND 9007199254740991 AND
	  "used_amount_fen" = trunc("used_amount_fen") AND
	  "used_amount_fen" BETWEEN 0 AND 9007199254740991 AND
	  "configured_operation_limit" = trunc("configured_operation_limit") AND
	  "configured_operation_limit" BETWEEN 0 AND 9007199254740991 AND
	  "configured_amount_limit_fen" = trunc("configured_amount_limit_fen") AND
	  "configured_amount_limit_fen" BETWEEN 0 AND 9007199254740991
	)
  );
  
  CREATE TABLE "provider_write_budget_debits" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"debit_key" varchar NOT NULL,
  	"budget_id" integer NOT NULL,
  	"operation_delta" numeric NOT NULL,
  	"amount_fen" numeric NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_write_budget_debits_safe_integers" CHECK (
	  "operation_delta" = trunc("operation_delta") AND
	  "operation_delta" BETWEEN 0 AND 9007199254740991 AND
	  "amount_fen" = trunc("amount_fen") AND
	  "amount_fen" BETWEEN 0 AND 9007199254740991
	)
  );
  
  ALTER TABLE "provider_write_budget_debits" ADD CONSTRAINT "provider_write_budget_debits_budget_id_provider_write_budgets_id_fk" FOREIGN KEY ("budget_id") REFERENCES "public"."provider_write_budgets"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "provider_write_budgets_scope_key_idx" ON "provider_write_budgets" USING btree ("scope_key");
  CREATE UNIQUE INDEX "provider_write_budgets_provider_capability_idx" ON "provider_write_budgets" USING btree ("provider", "capability");
  CREATE INDEX "provider_write_budgets_updated_at_idx" ON "provider_write_budgets" USING btree ("updated_at");
  CREATE INDEX "provider_write_budgets_created_at_idx" ON "provider_write_budgets" USING btree ("created_at");
  CREATE UNIQUE INDEX "provider_write_budget_debits_debit_key_idx" ON "provider_write_budget_debits" USING btree ("debit_key");
  CREATE INDEX "provider_write_budget_debits_budget_idx" ON "provider_write_budget_debits" USING btree ("budget_id");
  CREATE INDEX "provider_write_budget_debits_updated_at_idx" ON "provider_write_budget_debits" USING btree ("updated_at");
  CREATE INDEX "provider_write_budget_debits_created_at_idx" ON "provider_write_budget_debits" USING btree ("created_at");
  INSERT INTO "provider_write_budgets" (
    "scope_key",
    "provider",
    "capability",
    "used_operations",
    "used_amount_fen",
    "configured_operation_limit",
    "configured_amount_limit_fen",
    "updated_at",
    "created_at"
  ) VALUES
    ('westdigital:register_renew', 'westdigital', 'register_renew', 0, 0, 0, 0, NOW(), NOW()),
    ('wechatpay:payment', 'wechatpay', 'payment', 0, 0, 0, 0, NOW(), NOW()),
    ('wechatpay:refund', 'wechatpay', 'refund', 0, 0, 0, 0, NOW(), NOW())
  ON CONFLICT ("scope_key") DO NOTHING;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "provider_write_budget_debits" CASCADE;
  DROP TABLE "provider_write_budgets" CASCADE;
  DROP TYPE "public"."enum_provider_write_budgets_provider";
  DROP TYPE "public"."enum_provider_write_budgets_capability";`)
}
