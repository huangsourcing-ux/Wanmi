import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_price_snapshots_price_class" AS ENUM('standard');
  CREATE TYPE "public"."enum_price_snapshots_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_price_snapshots_provider" AS ENUM('westdigital_fixture');
  CREATE TYPE "public"."enum_price_snapshots_provider_cache_status" AS ENUM('hit', 'miss');
  CREATE TYPE "public"."enum_price_snapshots_rule_source" AS ENUM('wanmi_fixture');
  CREATE TYPE "public"."enum_price_snapshots_rule_mode" AS ENUM('fixed', 'percentage');
  CREATE TYPE "public"."enum_price_snapshots_rounding_mode" AS ENUM('half_up_to_fen');
  CREATE TYPE "public"."enum_price_snapshots_calculation_formula" AS ENUM('registration_price_plus_annual_renewal_price');
  CREATE TABLE "price_snapshots" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"schema_version" numeric DEFAULT 1 NOT NULL,
  	"calculation_version" numeric DEFAULT 1 NOT NULL,
  	"snapshot_ref" varchar NOT NULL,
  	"calculation_hash" varchar NOT NULL,
  	"tld" varchar NOT NULL,
  	"representative_domain_ascii" varchar NOT NULL,
  	"price_class" "enum_price_snapshots_price_class" NOT NULL,
  	"currency" "enum_price_snapshots_currency" NOT NULL,
  	"provider" "enum_price_snapshots_provider" NOT NULL,
  	"provider_product_id" varchar NOT NULL,
  	"provider_request_id" varchar NOT NULL,
  	"provider_observed_at" timestamp(3) with time zone NOT NULL,
  	"provider_cache_status" "enum_price_snapshots_provider_cache_status" NOT NULL,
  	"provider_cache_expires_at" timestamp(3) with time zone,
  	"rule_source" "enum_price_snapshots_rule_source" NOT NULL,
  	"rule_key" varchar NOT NULL,
  	"rule_version" numeric DEFAULT 1 NOT NULL,
  	"rule_mode" "enum_price_snapshots_rule_mode" NOT NULL,
  	"rule_fixed_amount_minor" numeric,
  	"rule_percentage_basis_points" numeric,
  	"rounding_mode" "enum_price_snapshots_rounding_mode" NOT NULL,
  	"upstream_registration_price_minor" numeric NOT NULL,
  	"upstream_renewal_price_minor" numeric NOT NULL,
  	"registration_price_minor" numeric NOT NULL,
  	"renewal_price_minor" numeric NOT NULL,
  	"one_year_total_minor" numeric NOT NULL,
  	"three_year_total_minor" numeric NOT NULL,
  	"calculation_formula" "enum_price_snapshots_calculation_formula" NOT NULL,
  	"created_trace_id" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE UNIQUE INDEX "price_snapshots_snapshot_ref_idx" ON "price_snapshots" USING btree ("snapshot_ref");
  CREATE UNIQUE INDEX "price_snapshots_calculation_hash_idx" ON "price_snapshots" USING btree ("calculation_hash");
  CREATE INDEX "price_snapshots_tld_idx" ON "price_snapshots" USING btree ("tld");
  CREATE INDEX "price_snapshots_provider_observed_at_idx" ON "price_snapshots" USING btree ("provider_observed_at");
  CREATE INDEX "price_snapshots_rule_key_idx" ON "price_snapshots" USING btree ("rule_key");
  CREATE INDEX "price_snapshots_created_trace_id_idx" ON "price_snapshots" USING btree ("created_trace_id");
  CREATE INDEX "price_snapshots_updated_at_idx" ON "price_snapshots" USING btree ("updated_at");
  CREATE INDEX "price_snapshots_created_at_idx" ON "price_snapshots" USING btree ("created_at");
  CREATE INDEX "tld_ruleKey_providerObservedAt_idx" ON "price_snapshots" USING btree ("tld","rule_key","provider_observed_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "price_snapshots" CASCADE;
  DROP TYPE "public"."enum_price_snapshots_price_class";
  DROP TYPE "public"."enum_price_snapshots_currency";
  DROP TYPE "public"."enum_price_snapshots_provider";
  DROP TYPE "public"."enum_price_snapshots_provider_cache_status";
  DROP TYPE "public"."enum_price_snapshots_rule_source";
  DROP TYPE "public"."enum_price_snapshots_rule_mode";
  DROP TYPE "public"."enum_price_snapshots_rounding_mode";
  DROP TYPE "public"."enum_price_snapshots_calculation_formula";`)
}
