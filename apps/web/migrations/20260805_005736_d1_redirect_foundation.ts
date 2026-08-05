import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   UPDATE "redirects" SET "type" = '301' WHERE "type" = '302';
  ALTER TABLE "redirects" ALTER COLUMN "type" SET DATA TYPE text;
  DROP TYPE "public"."enum_redirects_type";
  CREATE TYPE "public"."enum_redirects_type" AS ENUM('301');
  ALTER TABLE "redirects" ALTER COLUMN "type" SET DATA TYPE "public"."enum_redirects_type" USING "type"::"public"."enum_redirects_type";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_redirects_type" ADD VALUE '302';`)
}
