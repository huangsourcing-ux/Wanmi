import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_realname_templates_applicable_scopes" AS ENUM('cg', 'gswl', 'hk');
  CREATE TYPE "public"."enum_realname_templates_phone_type" AS ENUM('mobile', 'landline');
  CREATE TYPE "public"."enum_realname_templates_provider_review_state" AS ENUM('unsubmitted', 'pending', 'approved', 'rejected', 'unknown');
  CREATE TYPE "public"."enum_realname_templates_safe_failure_reason" AS ENUM('identity_mismatch', 'material_invalid', 'provider_unavailable', 'status_unknown', 'other');
  CREATE TABLE "realname_templates_applicable_scopes" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_realname_templates_applicable_scopes",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  ALTER TABLE "realname_templates" ALTER COLUMN "status" SET DATA TYPE text;
  ALTER TABLE "realname_templates" ALTER COLUMN "status" SET DEFAULT 'draft'::text;
  UPDATE "realname_templates" SET "status" = 'approved' WHERE "status" = 'verified';
  DROP TYPE "public"."enum_realname_templates_status";
  CREATE TYPE "public"."enum_realname_templates_status" AS ENUM('draft', 'pending_review', 'approved', 'rejected', 'manual_review', 'disabled');
  ALTER TABLE "realname_templates" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."enum_realname_templates_status";
  ALTER TABLE "realname_templates" ALTER COLUMN "status" SET DATA TYPE "public"."enum_realname_templates_status" USING "status"::"public"."enum_realname_templates_status";
  UPDATE "realname_templates" SET "safe_failure_reason" = NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "safe_failure_reason" SET DATA TYPE "public"."enum_realname_templates_safe_failure_reason" USING "safe_failure_reason"::"public"."enum_realname_templates_safe_failure_reason";
  ALTER TABLE "realname_templates" ADD COLUMN "full_name_chinese" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "organization_name_chinese" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "organization_name_english" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "contact_last_name_chinese" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "contact_first_name_chinese" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "contact_last_name_english" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "contact_first_name_english" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "country_code" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "province_chinese" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "city_chinese" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "district_chinese" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "address_chinese" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "province_english" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "city_english" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "address_english" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "postal_code" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "phone_country_code" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "phone_type" "enum_realname_templates_phone_type";
  ALTER TABLE "realname_templates" ADD COLUMN "phone" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "phone_area_code" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "phone_extension" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "email" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "identity_document_type" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "identity_document_number" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "provider_review_state" "enum_realname_templates_provider_review_state" DEFAULT 'unsubmitted' NOT NULL;
  ALTER TABLE "realname_templates" ADD COLUMN "provider_request_id" varchar;
  ALTER TABLE "realname_templates" ADD COLUMN "provider_confirmed_at" timestamp(3) with time zone;
  ALTER TABLE "realname_templates" ADD COLUMN "provider_last_checked_at" timestamp(3) with time zone;
  UPDATE "realname_templates" SET
    "status" = 'disabled',
    "full_name_chinese" = '历史模板已停用',
    "contact_last_name_chinese" = '待',
    "contact_first_name_chinese" = '补录',
    "contact_last_name_english" = 'Pending',
    "contact_first_name_english" = 'Review',
    "country_code" = 'CN',
    "province_chinese" = '待补录',
    "city_chinese" = '待补录',
    "district_chinese" = '待补录',
    "address_chinese" = '历史模板已停用待补录',
    "province_english" = 'Pending',
    "city_english" = 'Review',
    "address_english" = 'Legacy template disabled',
    "postal_code" = '000000',
    "phone_country_code" = '+86',
    "phone_type" = 'mobile',
    "phone" = '000',
    "email" = 'disabled-' || "id" || '@invalid.example',
    "identity_document_type" = 'UNKNOWN',
    "identity_document_number" = 'legacy-disabled-' || "id",
    "provider_review_state" = 'unknown',
    "disabled_at" = now();
  INSERT INTO "realname_templates_applicable_scopes" ("order", "parent_id", "value")
    SELECT 1, "id", 'cg' FROM "realname_templates";
  ALTER TABLE "realname_templates" ALTER COLUMN "full_name_chinese" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "contact_last_name_chinese" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "contact_first_name_chinese" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "contact_last_name_english" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "contact_first_name_english" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "country_code" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "province_chinese" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "city_chinese" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "district_chinese" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "address_chinese" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "province_english" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "city_english" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "address_english" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "postal_code" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "phone_country_code" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "phone_type" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "phone" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "email" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "identity_document_type" SET NOT NULL;
  ALTER TABLE "realname_templates" ALTER COLUMN "identity_document_number" SET NOT NULL;
  ALTER TABLE "realname_templates_applicable_scopes" ADD CONSTRAINT "realname_templates_applicable_scopes_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."realname_templates"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "realname_templates_applicable_scopes_order_idx" ON "realname_templates_applicable_scopes" USING btree ("order");
  CREATE INDEX "realname_templates_applicable_scopes_parent_idx" ON "realname_templates_applicable_scopes" USING btree ("parent_id");
  CREATE INDEX "realname_templates_status_idx" ON "realname_templates" USING btree ("status");
  CREATE INDEX "realname_templates_provider_request_id_idx" ON "realname_templates" USING btree ("provider_request_id");
  CREATE INDEX "realname_templates_provider_confirmed_at_idx" ON "realname_templates" USING btree ("provider_confirmed_at");
  CREATE INDEX "realname_templates_provider_last_checked_at_idx" ON "realname_templates" USING btree ("provider_last_checked_at");
  CREATE INDEX "realname_templates_disabled_at_idx" ON "realname_templates" USING btree ("disabled_at");
  CREATE INDEX "customer_status_idx" ON "realname_templates" USING btree ("customer_id","status");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "realname_templates_applicable_scopes" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "realname_templates_applicable_scopes" CASCADE;
  ALTER TABLE "realname_templates" ALTER COLUMN "status" SET DATA TYPE text;
  ALTER TABLE "realname_templates" ALTER COLUMN "status" SET DEFAULT 'draft'::text;
  UPDATE "realname_templates" SET "status" = 'verified' WHERE "status" = 'approved';
  DROP TYPE "public"."enum_realname_templates_status";
  CREATE TYPE "public"."enum_realname_templates_status" AS ENUM('draft', 'pending_review', 'verified', 'rejected', 'manual_review', 'disabled');
  ALTER TABLE "realname_templates" ALTER COLUMN "status" SET DEFAULT 'draft'::"public"."enum_realname_templates_status";
  ALTER TABLE "realname_templates" ALTER COLUMN "status" SET DATA TYPE "public"."enum_realname_templates_status" USING "status"::"public"."enum_realname_templates_status";
  DROP INDEX "realname_templates_status_idx";
  DROP INDEX "realname_templates_provider_request_id_idx";
  DROP INDEX "realname_templates_provider_confirmed_at_idx";
  DROP INDEX "realname_templates_provider_last_checked_at_idx";
  DROP INDEX "realname_templates_disabled_at_idx";
  DROP INDEX "customer_status_idx";
  ALTER TABLE "realname_templates" ALTER COLUMN "safe_failure_reason" SET DATA TYPE varchar;
  ALTER TABLE "realname_templates" DROP COLUMN "full_name_chinese";
  ALTER TABLE "realname_templates" DROP COLUMN "organization_name_chinese";
  ALTER TABLE "realname_templates" DROP COLUMN "organization_name_english";
  ALTER TABLE "realname_templates" DROP COLUMN "contact_last_name_chinese";
  ALTER TABLE "realname_templates" DROP COLUMN "contact_first_name_chinese";
  ALTER TABLE "realname_templates" DROP COLUMN "contact_last_name_english";
  ALTER TABLE "realname_templates" DROP COLUMN "contact_first_name_english";
  ALTER TABLE "realname_templates" DROP COLUMN "country_code";
  ALTER TABLE "realname_templates" DROP COLUMN "province_chinese";
  ALTER TABLE "realname_templates" DROP COLUMN "city_chinese";
  ALTER TABLE "realname_templates" DROP COLUMN "district_chinese";
  ALTER TABLE "realname_templates" DROP COLUMN "address_chinese";
  ALTER TABLE "realname_templates" DROP COLUMN "province_english";
  ALTER TABLE "realname_templates" DROP COLUMN "city_english";
  ALTER TABLE "realname_templates" DROP COLUMN "address_english";
  ALTER TABLE "realname_templates" DROP COLUMN "postal_code";
  ALTER TABLE "realname_templates" DROP COLUMN "phone_country_code";
  ALTER TABLE "realname_templates" DROP COLUMN "phone_type";
  ALTER TABLE "realname_templates" DROP COLUMN "phone";
  ALTER TABLE "realname_templates" DROP COLUMN "phone_area_code";
  ALTER TABLE "realname_templates" DROP COLUMN "phone_extension";
  ALTER TABLE "realname_templates" DROP COLUMN "email";
  ALTER TABLE "realname_templates" DROP COLUMN "identity_document_type";
  ALTER TABLE "realname_templates" DROP COLUMN "identity_document_number";
  ALTER TABLE "realname_templates" DROP COLUMN "provider_review_state";
  ALTER TABLE "realname_templates" DROP COLUMN "provider_request_id";
  ALTER TABLE "realname_templates" DROP COLUMN "provider_confirmed_at";
  ALTER TABLE "realname_templates" DROP COLUMN "provider_last_checked_at";
  DROP TYPE "public"."enum_realname_templates_applicable_scopes";
  DROP TYPE "public"."enum_realname_templates_phone_type";
  DROP TYPE "public"."enum_realname_templates_provider_review_state";
  DROP TYPE "public"."enum_realname_templates_safe_failure_reason";`)
}
