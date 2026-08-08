import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_quotes_rule_source" ADD VALUE 'price_rule_collection';
  ALTER TYPE "public"."enum_price_snapshots_rule_source" ADD VALUE 'price_rule_collection';
  ALTER TABLE "price_rules" ALTER COLUMN "fixed_amount_minor" DROP NOT NULL;
  UPDATE "price_rules" SET "percentage_basis_points" = NULL WHERE "mode" = 'fixed';
  UPDATE "price_rules" SET "fixed_amount_minor" = NULL WHERE "mode" = 'percentage';
  ALTER TABLE "price_rules" ADD COLUMN "effective_at" timestamp(3) with time zone;
  UPDATE "price_rules" SET "effective_at" = "updated_at";
  ALTER TABLE "price_rules" ALTER COLUMN "effective_at" SET NOT NULL;
  CREATE INDEX "price_rules_effective_at_idx" ON "price_rules" USING btree ("effective_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "quotes" ALTER COLUMN "rule_source" SET DATA TYPE text;
  UPDATE "quotes" SET "rule_source" = 'wanmi_fixture'
  WHERE "rule_source" = 'price_rule_collection';
  DROP TYPE "public"."enum_quotes_rule_source";
  CREATE TYPE "public"."enum_quotes_rule_source" AS ENUM('wanmi_fixture');
  ALTER TABLE "quotes" ALTER COLUMN "rule_source" SET DATA TYPE "public"."enum_quotes_rule_source" USING "rule_source"::"public"."enum_quotes_rule_source";
  ALTER TABLE "price_snapshots" ALTER COLUMN "rule_source" SET DATA TYPE text;
  UPDATE "price_snapshots" SET "rule_source" = 'wanmi_fixture'
  WHERE "rule_source" = 'price_rule_collection';
  DROP TYPE "public"."enum_price_snapshots_rule_source";
  CREATE TYPE "public"."enum_price_snapshots_rule_source" AS ENUM('wanmi_fixture');
  ALTER TABLE "price_snapshots" ALTER COLUMN "rule_source" SET DATA TYPE "public"."enum_price_snapshots_rule_source" USING "rule_source"::"public"."enum_price_snapshots_rule_source";
  DROP INDEX "price_rules_effective_at_idx";
  UPDATE "price_rules" SET "fixed_amount_minor" = 0 WHERE "fixed_amount_minor" IS NULL;
  ALTER TABLE "price_rules" ALTER COLUMN "fixed_amount_minor" SET NOT NULL;
  ALTER TABLE "price_rules" DROP COLUMN "effective_at";`)
}
