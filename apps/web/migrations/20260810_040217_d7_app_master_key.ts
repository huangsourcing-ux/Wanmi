import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "realname_documents" ADD COLUMN "master_key_version" varchar;
   UPDATE "realname_documents"
   SET "master_key_version" = 'legacy-kms-unavailable',
       "storage_state" = 'upload_failed';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "realname_documents" DROP COLUMN "master_key_version";`)
}
