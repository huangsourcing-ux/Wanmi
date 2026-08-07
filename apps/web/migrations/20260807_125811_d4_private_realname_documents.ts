import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_realname_documents_encryption_version" AS ENUM('aes-256-gcm-v1');
  CREATE TYPE "public"."enum_realname_documents_file_kind" AS ENUM('jpeg', 'png', 'pdf');
  CREATE TYPE "public"."enum_realname_documents_storage_state" AS ENUM('uploading', 'active', 'upload_failed', 'deleting', 'deleted');
  ALTER TABLE "realname_documents" ADD COLUMN "encryption_version" "enum_realname_documents_encryption_version" DEFAULT 'aes-256-gcm-v1' NOT NULL;
  ALTER TABLE "realname_documents" ADD COLUMN "iv" varchar;
  ALTER TABLE "realname_documents" ADD COLUMN "auth_tag" varchar;
  ALTER TABLE "realname_documents" ADD COLUMN "file_kind" "enum_realname_documents_file_kind";
  ALTER TABLE "realname_documents" ADD COLUMN "storage_state" "enum_realname_documents_storage_state" DEFAULT 'uploading' NOT NULL;
  ALTER TABLE "realname_documents" ADD COLUMN "submitted_at" timestamp(3) with time zone;
  UPDATE "realname_documents" SET
    "iv" = 'legacy-unavailable',
    "auth_tag" = 'legacy-unavailable',
    "file_kind" = CASE
      WHEN "content_type" = 'image/jpeg' THEN 'jpeg'::"public"."enum_realname_documents_file_kind"
      WHEN "content_type" = 'image/png' THEN 'png'::"public"."enum_realname_documents_file_kind"
      ELSE 'pdf'::"public"."enum_realname_documents_file_kind"
    END,
    "storage_state" = 'upload_failed';
  ALTER TABLE "realname_documents" ALTER COLUMN "iv" SET NOT NULL;
  ALTER TABLE "realname_documents" ALTER COLUMN "auth_tag" SET NOT NULL;
  ALTER TABLE "realname_documents" ALTER COLUMN "file_kind" SET NOT NULL;
  CREATE INDEX "realname_documents_storage_state_idx" ON "realname_documents" USING btree ("storage_state");
  CREATE INDEX "realname_documents_submitted_at_idx" ON "realname_documents" USING btree ("submitted_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "realname_documents_storage_state_idx";
  DROP INDEX "realname_documents_submitted_at_idx";
  ALTER TABLE "realname_documents" DROP COLUMN "encryption_version";
  ALTER TABLE "realname_documents" DROP COLUMN "iv";
  ALTER TABLE "realname_documents" DROP COLUMN "auth_tag";
  ALTER TABLE "realname_documents" DROP COLUMN "file_kind";
  ALTER TABLE "realname_documents" DROP COLUMN "storage_state";
  ALTER TABLE "realname_documents" DROP COLUMN "submitted_at";
  DROP TYPE "public"."enum_realname_documents_encryption_version";
  DROP TYPE "public"."enum_realname_documents_file_kind";
  DROP TYPE "public"."enum_realname_documents_storage_state";`)
}
