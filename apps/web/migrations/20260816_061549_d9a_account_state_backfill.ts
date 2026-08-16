import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  UPDATE "customers"
  SET "status" = (CASE "status"::text
    WHEN 'disabled' THEN 'suspended'
    WHEN 'deletion_requested' THEN 'closing'
    ELSE "status"::text
  END)::"public"."enum_customers_status";
  ALTER TABLE "customers" ALTER COLUMN "status" SET DEFAULT 'pending_registration'::"public"."enum_customers_status";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  UPDATE "customers"
  SET "status" = (CASE "status"::text
    WHEN 'suspended' THEN 'disabled'
    WHEN 'closing' THEN 'deletion_requested'
    WHEN 'closed' THEN 'deletion_requested'
    ELSE 'active'
  END)::"public"."enum_customers_status";
  ALTER TABLE "customers" ALTER COLUMN "status" SET DEFAULT 'active'::"public"."enum_customers_status";`)
}
