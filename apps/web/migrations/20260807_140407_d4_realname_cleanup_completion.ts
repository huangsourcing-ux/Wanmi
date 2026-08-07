import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "realname_templates" ADD COLUMN "cleanup_completed_at" timestamp(3) with time zone;
  CREATE INDEX "realname_templates_cleanup_completed_at_idx" ON "realname_templates" USING btree ("cleanup_completed_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "realname_templates_cleanup_completed_at_idx";
  ALTER TABLE "realname_templates" DROP COLUMN "cleanup_completed_at";`)
}
