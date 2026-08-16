import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
  ALTER TYPE "public"."enum_customers_status" ADD VALUE IF NOT EXISTS 'pending_registration';
  ALTER TYPE "public"."enum_customers_status" ADD VALUE IF NOT EXISTS 'restricted';
  ALTER TYPE "public"."enum_customers_status" ADD VALUE IF NOT EXISTS 'suspended';
  ALTER TYPE "public"."enum_customers_status" ADD VALUE IF NOT EXISTS 'closing';
  ALTER TYPE "public"."enum_customers_status" ADD VALUE IF NOT EXISTS 'closed';
  ALTER TABLE "customers" ADD COLUMN "capability_restrictions" jsonb DEFAULT '[]'::jsonb NOT NULL;
  CREATE INDEX "customers_status_idx" ON "customers" USING btree ("status");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DROP INDEX "customers_status_idx";
  ALTER TABLE "customers" DROP COLUMN "capability_restrictions";`)
}
