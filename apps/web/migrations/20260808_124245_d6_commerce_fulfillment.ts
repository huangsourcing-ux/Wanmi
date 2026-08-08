import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "orders" ADD COLUMN "fulfillment_job_queued_at" timestamp(3) with time zone;
  CREATE INDEX "orders_fulfillment_job_queued_at_idx" ON "orders" USING btree ("fulfillment_job_queued_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "orders_fulfillment_job_queued_at_idx";
  ALTER TABLE "orders" DROP COLUMN "fulfillment_job_queued_at";`)
}
