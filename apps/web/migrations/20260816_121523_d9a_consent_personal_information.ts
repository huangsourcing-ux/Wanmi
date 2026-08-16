import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_consent_records_source" ADD VALUE 'legacy_profile_completion';
  ALTER TYPE "public"."enum_consent_records_source" ADD VALUE 'account_privacy_center';
  ALTER TABLE "customers" ADD COLUMN "legacy_profile_completed_at" timestamp(3) with time zone;
  ALTER TABLE "customers" ADD COLUMN "consent_state_version" numeric DEFAULT 0;
  CREATE INDEX "customers_legacy_profile_completed_at_idx" ON "customers" USING btree ("legacy_profile_completed_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "consent_records" ALTER COLUMN "source" SET DATA TYPE text;
  DROP TYPE "public"."enum_consent_records_source";
  CREATE TYPE "public"."enum_consent_records_source" AS ENUM('phone_registration', 'wechat_oauth_registration', 'wechat_qrcode_registration');
  ALTER TABLE "consent_records" ALTER COLUMN "source" SET DATA TYPE "public"."enum_consent_records_source" USING "source"::"public"."enum_consent_records_source";
  DROP INDEX "customers_legacy_profile_completed_at_idx";
  ALTER TABLE "customers" DROP COLUMN "legacy_profile_completed_at";
  ALTER TABLE "customers" DROP COLUMN "consent_state_version";`)
}
