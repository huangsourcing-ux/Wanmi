import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'realnameCleanup' BEFORE 'commerceFulfillment';
  CREATE TABLE "realname_documents_backup_objects" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"object_key" varchar NOT NULL,
  	"deleted_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "realname_documents" ADD COLUMN "primary_object_deleted_at" timestamp(3) with time zone;
  ALTER TABLE "manual_reviews" ADD COLUMN "realname_template_id" integer;
  ALTER TABLE "realname_documents_backup_objects" ADD CONSTRAINT "realname_documents_backup_objects_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."realname_documents"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "realname_documents_backup_objects_order_idx" ON "realname_documents_backup_objects" USING btree ("_order");
  CREATE INDEX "realname_documents_backup_objects_parent_id_idx" ON "realname_documents_backup_objects" USING btree ("_parent_id");
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_realname_template_id_realname_templates_id_fk" FOREIGN KEY ("realname_template_id") REFERENCES "public"."realname_templates"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "realname_documents_primary_object_deleted_at_idx" ON "realname_documents" USING btree ("primary_object_deleted_at");
  CREATE INDEX "manual_reviews_realname_template_idx" ON "manual_reviews" USING btree ("realname_template_id");
  CREATE UNIQUE INDEX "realname_documents_backup_objects_object_key_unique" ON "realname_documents_backup_objects" USING btree ("object_key");
  UPDATE "realname_templates"
  SET
    "disabled_at" = COALESCE("disabled_at", "updated_at"),
    "cleanup_due_at" = COALESCE(
      "cleanup_due_at",
      COALESCE("disabled_at", "updated_at") + interval '30 days'
    )
  WHERE "status" = 'disabled';
  INSERT INTO "manual_reviews" (
    "realname_template_id", "reason_code", "status", "updated_at", "created_at"
  )
  SELECT "id", 'legacy_realname_manual_review', 'open', now(), now()
  FROM "realname_templates" AS "template"
  WHERE "template"."status" = 'manual_review'
    AND NOT EXISTS (
      SELECT 1 FROM "manual_reviews" AS "review"
      WHERE "review"."realname_template_id" = "template"."id"
        AND "review"."status" = 'open'
    );
  CREATE UNIQUE INDEX "manual_reviews_one_open_realname_template_unique"
    ON "manual_reviews" USING btree ("realname_template_id")
    WHERE "realname_template_id" IS NOT NULL AND "status" = 'open';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  ALTER TABLE "realname_documents_backup_objects" DISABLE ROW LEVEL SECURITY;
  DROP INDEX "manual_reviews_one_open_realname_template_unique";
  DROP TABLE "realname_documents_backup_objects" CASCADE;
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_realname_template_id_realname_templates_id_fk";
  
  DELETE FROM "payload_jobs" WHERE "workflow_slug"::text = 'realnameCleanup';
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'commerceFulfillment');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "realname_documents_primary_object_deleted_at_idx";
  DROP INDEX "manual_reviews_realname_template_idx";
  ALTER TABLE "realname_documents" DROP COLUMN "primary_object_deleted_at";
  ALTER TABLE "manual_reviews" DROP COLUMN "realname_template_id";`)
}
