import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_provider_operations_target_type" AS ENUM('order', 'realname_template', 'domain');
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'realname' BEFORE 'register';
  ALTER TABLE "provider_operations" ALTER COLUMN "order_id" DROP NOT NULL;
  ALTER TABLE "provider_operations" ADD COLUMN "realname_template_id" integer;
  ALTER TABLE "provider_operations" ADD COLUMN "target_type" "enum_provider_operations_target_type";
  ALTER TABLE "provider_operations" ADD COLUMN "target_id" varchar;
  ALTER TABLE "provider_operations" ADD COLUMN "attempt_count" numeric DEFAULT 0 NOT NULL;
  ALTER TABLE "provider_operations" ADD COLUMN "max_attempts" numeric DEFAULT 3 NOT NULL;
  ALTER TABLE "provider_operations" ADD COLUMN "last_error_code" varchar;
  UPDATE "provider_operations"
    SET "target_type" = 'order', "target_id" = "order_id"::text
    WHERE "target_type" IS NULL OR "target_id" IS NULL;
  ALTER TABLE "provider_operations" ALTER COLUMN "target_type" SET NOT NULL;
  ALTER TABLE "provider_operations" ALTER COLUMN "target_id" SET NOT NULL;
  ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_realname_template_id_realname_templates_id_fk" FOREIGN KEY ("realname_template_id") REFERENCES "public"."realname_templates"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "provider_operations_realname_template_idx" ON "provider_operations" USING btree ("realname_template_id");
  CREATE INDEX "provider_operations_target_id_idx" ON "provider_operations" USING btree ("target_id");
  CREATE INDEX "provider_operations_last_error_code_idx" ON "provider_operations" USING btree ("last_error_code");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "provider_operations" DROP CONSTRAINT "provider_operations_realname_template_id_realname_templates_id_fk";
  DELETE FROM "provider_operations"
    WHERE "order_id" IS NULL OR "operation" = 'realname';
  
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE text;
  DROP TYPE "public"."enum_provider_operations_operation";
  CREATE TYPE "public"."enum_provider_operations_operation" AS ENUM('register', 'renew', 'refund', 'nameserver', 'query');
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE "public"."enum_provider_operations_operation" USING "operation"::"public"."enum_provider_operations_operation";
  DROP INDEX "provider_operations_realname_template_idx";
  DROP INDEX "provider_operations_target_id_idx";
  DROP INDEX "provider_operations_last_error_code_idx";
  ALTER TABLE "provider_operations" ALTER COLUMN "order_id" SET NOT NULL;
  ALTER TABLE "provider_operations" DROP COLUMN "realname_template_id";
  ALTER TABLE "provider_operations" DROP COLUMN "target_type";
  ALTER TABLE "provider_operations" DROP COLUMN "target_id";
  ALTER TABLE "provider_operations" DROP COLUMN "attempt_count";
  ALTER TABLE "provider_operations" DROP COLUMN "max_attempts";
  ALTER TABLE "provider_operations" DROP COLUMN "last_error_code";
  DROP TYPE "public"."enum_provider_operations_target_type";`)
}
