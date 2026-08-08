import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_quotes_price_class" AS ENUM('standard');
  CREATE TYPE "public"."enum_quotes_provider" AS ENUM('westdigital_fixture');
  CREATE TYPE "public"."enum_quotes_provider_cache_status" AS ENUM('hit', 'miss');
  CREATE TYPE "public"."enum_quotes_rule_source" AS ENUM('wanmi_fixture');
  CREATE TYPE "public"."enum_quotes_rule_mode" AS ENUM('fixed', 'percentage');
  CREATE TYPE "public"."enum_quotes_rounding_mode" AS ENUM('half_up_to_fen');
  CREATE TYPE "public"."enum_quotes_calculation_formula" AS ENUM('registration_price_plus_annual_renewal_price');
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_quotes_fk";
  
  DROP INDEX "payload_locked_documents_rels_quotes_id_idx";
  ALTER TABLE "quotes" ADD COLUMN "schema_version" numeric DEFAULT 1 NOT NULL;
  ALTER TABLE "quotes" ADD COLUMN "calculation_version" numeric DEFAULT 1 NOT NULL;
  ALTER TABLE "quotes" ADD COLUMN "quote_ref" varchar;
  ALTER TABLE "quotes" ADD COLUMN "tld" varchar;
  ALTER TABLE "quotes" ADD COLUMN "price_class" "enum_quotes_price_class";
  ALTER TABLE "quotes" ADD COLUMN "source_price_snapshot_ref" varchar;
  ALTER TABLE "quotes" ADD COLUMN "source_calculation_hash" varchar;
  ALTER TABLE "quotes" ADD COLUMN "quote_integrity_hash" varchar;
  ALTER TABLE "quotes" ADD COLUMN "provider" "enum_quotes_provider";
  ALTER TABLE "quotes" ADD COLUMN "provider_product_id" varchar;
  ALTER TABLE "quotes" ADD COLUMN "provider_request_id" varchar;
  ALTER TABLE "quotes" ADD COLUMN "provider_observed_at" timestamp(3) with time zone;
  ALTER TABLE "quotes" ADD COLUMN "provider_cache_status" "enum_quotes_provider_cache_status";
  ALTER TABLE "quotes" ADD COLUMN "provider_cache_expires_at" timestamp(3) with time zone;
  ALTER TABLE "quotes" ADD COLUMN "availability_request_id" varchar;
  ALTER TABLE "quotes" ADD COLUMN "availability_observed_at" timestamp(3) with time zone;
  ALTER TABLE "quotes" ADD COLUMN "rule_source" "enum_quotes_rule_source";
  ALTER TABLE "quotes" ADD COLUMN "rule_key" varchar;
  ALTER TABLE "quotes" ADD COLUMN "rule_version" numeric DEFAULT 1 NOT NULL;
  ALTER TABLE "quotes" ADD COLUMN "rule_mode" "enum_quotes_rule_mode";
  ALTER TABLE "quotes" ADD COLUMN "rule_fixed_amount_minor" numeric;
  ALTER TABLE "quotes" ADD COLUMN "rule_percentage_basis_points" numeric;
  ALTER TABLE "quotes" ADD COLUMN "rounding_mode" "enum_quotes_rounding_mode";
  ALTER TABLE "quotes" ADD COLUMN "calculation_formula" "enum_quotes_calculation_formula";
  ALTER TABLE "quotes" ADD COLUMN "upstream_registration_price_minor" numeric;
  ALTER TABLE "quotes" ADD COLUMN "upstream_renewal_price_minor" numeric;
  ALTER TABLE "quotes" ADD COLUMN "registration_price_minor" numeric;
  ALTER TABLE "quotes" ADD COLUMN "renewal_price_minor" numeric;
  ALTER TABLE "quotes" ADD COLUMN "quoted_at" timestamp(3) with time zone;
  ALTER TABLE "quotes" ADD COLUMN "created_trace_id" varchar;
  UPDATE "quotes" SET
    "quote_ref" = substr(md5('legacy-quote:' || "id"::text), 1, 8) || '-' || substr(md5('legacy-quote:' || "id"::text), 9, 4) || '-4' || substr(md5('legacy-quote:' || "id"::text), 14, 3) || '-8' || substr(md5('legacy-quote:' || "id"::text), 18, 3) || '-' || substr(md5('legacy-quote:' || "id"::text), 21, 12),
    "tld" = lower(regexp_replace("domain_ascii", '^.*\\.', '')),
    "price_class" = 'standard',
    "source_price_snapshot_ref" = substr(md5('legacy-source:' || "id"::text), 1, 8) || '-' || substr(md5('legacy-source:' || "id"::text), 9, 4) || '-4' || substr(md5('legacy-source:' || "id"::text), 14, 3) || '-8' || substr(md5('legacy-source:' || "id"::text), 18, 3) || '-' || substr(md5('legacy-source:' || "id"::text), 21, 12),
    "source_calculation_hash" = repeat('0', 64),
    "quote_integrity_hash" = repeat('f', 64),
    "provider" = 'westdigital_fixture',
    "provider_product_id" = 'legacy-untrusted',
    "provider_request_id" = 'legacy-untrusted',
    "provider_observed_at" = "created_at",
    "provider_cache_status" = 'miss',
    "availability_request_id" = 'legacy-untrusted',
    "availability_observed_at" = "created_at",
    "rule_source" = 'wanmi_fixture',
    "rule_key" = 'legacy-untrusted-v1',
    "rule_mode" = 'fixed',
    "rule_fixed_amount_minor" = 0,
    "rounding_mode" = 'half_up_to_fen',
    "calculation_formula" = 'registration_price_plus_annual_renewal_price',
    "upstream_registration_price_minor" = "upstream_cost_minor",
    "upstream_renewal_price_minor" = "upstream_cost_minor",
    "registration_price_minor" = "user_price_minor",
    "renewal_price_minor" = "user_price_minor",
    "quoted_at" = "created_at",
    "created_trace_id" = 'legacy-untrusted',
    "expires_at" = LEAST("expires_at", CURRENT_TIMESTAMP);
  ALTER TABLE "quotes" ALTER COLUMN "quote_ref" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "tld" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "price_class" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "source_price_snapshot_ref" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "source_calculation_hash" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "quote_integrity_hash" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "provider" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "provider_product_id" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "provider_request_id" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "provider_observed_at" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "provider_cache_status" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "availability_request_id" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "availability_observed_at" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "rule_source" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "rule_key" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "rule_mode" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "rounding_mode" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "calculation_formula" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "upstream_registration_price_minor" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "upstream_renewal_price_minor" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "registration_price_minor" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "renewal_price_minor" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "quoted_at" SET NOT NULL;
  ALTER TABLE "quotes" ALTER COLUMN "created_trace_id" SET NOT NULL;
  CREATE UNIQUE INDEX "quotes_quote_ref_idx" ON "quotes" USING btree ("quote_ref");
  CREATE INDEX "quotes_tld_idx" ON "quotes" USING btree ("tld");
  CREATE INDEX "quotes_source_price_snapshot_ref_idx" ON "quotes" USING btree ("source_price_snapshot_ref");
  CREATE INDEX "quotes_provider_observed_at_idx" ON "quotes" USING btree ("provider_observed_at");
  CREATE INDEX "quotes_quoted_at_idx" ON "quotes" USING btree ("quoted_at");
  CREATE INDEX "customer_expiresAt_idx" ON "quotes" USING btree ("customer_id","expires_at");
  CREATE INDEX "domainAscii_quotedAt_idx" ON "quotes" USING btree ("domain_ascii","quoted_at");
  ALTER TABLE "quotes" DROP COLUMN "rule_snapshot";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "quotes_id";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "quotes_quote_ref_idx";
  DROP INDEX "quotes_tld_idx";
  DROP INDEX "quotes_source_price_snapshot_ref_idx";
  DROP INDEX "quotes_provider_observed_at_idx";
  DROP INDEX "quotes_quoted_at_idx";
  DROP INDEX "customer_expiresAt_idx";
  DROP INDEX "domainAscii_quotedAt_idx";
  ALTER TABLE "quotes" ADD COLUMN "rule_snapshot" jsonb;
  UPDATE "quotes" SET "rule_snapshot" = jsonb_build_object(
    'source', "rule_source",
    'key', "rule_key",
    'version', "rule_version",
    'mode', "rule_mode",
    'fixedAmountMinor', "rule_fixed_amount_minor",
    'percentageBasisPoints', "rule_percentage_basis_points"
  );
  ALTER TABLE "quotes" ALTER COLUMN "rule_snapshot" SET NOT NULL;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "quotes_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_quotes_fk" FOREIGN KEY ("quotes_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_quotes_id_idx" ON "payload_locked_documents_rels" USING btree ("quotes_id");
  ALTER TABLE "quotes" DROP COLUMN "schema_version";
  ALTER TABLE "quotes" DROP COLUMN "calculation_version";
  ALTER TABLE "quotes" DROP COLUMN "quote_ref";
  ALTER TABLE "quotes" DROP COLUMN "tld";
  ALTER TABLE "quotes" DROP COLUMN "price_class";
  ALTER TABLE "quotes" DROP COLUMN "source_price_snapshot_ref";
  ALTER TABLE "quotes" DROP COLUMN "source_calculation_hash";
  ALTER TABLE "quotes" DROP COLUMN "quote_integrity_hash";
  ALTER TABLE "quotes" DROP COLUMN "provider";
  ALTER TABLE "quotes" DROP COLUMN "provider_product_id";
  ALTER TABLE "quotes" DROP COLUMN "provider_request_id";
  ALTER TABLE "quotes" DROP COLUMN "provider_observed_at";
  ALTER TABLE "quotes" DROP COLUMN "provider_cache_status";
  ALTER TABLE "quotes" DROP COLUMN "provider_cache_expires_at";
  ALTER TABLE "quotes" DROP COLUMN "availability_request_id";
  ALTER TABLE "quotes" DROP COLUMN "availability_observed_at";
  ALTER TABLE "quotes" DROP COLUMN "rule_source";
  ALTER TABLE "quotes" DROP COLUMN "rule_key";
  ALTER TABLE "quotes" DROP COLUMN "rule_version";
  ALTER TABLE "quotes" DROP COLUMN "rule_mode";
  ALTER TABLE "quotes" DROP COLUMN "rule_fixed_amount_minor";
  ALTER TABLE "quotes" DROP COLUMN "rule_percentage_basis_points";
  ALTER TABLE "quotes" DROP COLUMN "rounding_mode";
  ALTER TABLE "quotes" DROP COLUMN "calculation_formula";
  ALTER TABLE "quotes" DROP COLUMN "upstream_registration_price_minor";
  ALTER TABLE "quotes" DROP COLUMN "upstream_renewal_price_minor";
  ALTER TABLE "quotes" DROP COLUMN "registration_price_minor";
  ALTER TABLE "quotes" DROP COLUMN "renewal_price_minor";
  ALTER TABLE "quotes" DROP COLUMN "quoted_at";
  ALTER TABLE "quotes" DROP COLUMN "created_trace_id";
  DROP TYPE "public"."enum_quotes_price_class";
  DROP TYPE "public"."enum_quotes_provider";
  DROP TYPE "public"."enum_quotes_provider_cache_status";
  DROP TYPE "public"."enum_quotes_rule_source";
  DROP TYPE "public"."enum_quotes_rule_mode";
  DROP TYPE "public"."enum_quotes_rounding_mode";
  DROP TYPE "public"."enum_quotes_calculation_formula";`)
}
