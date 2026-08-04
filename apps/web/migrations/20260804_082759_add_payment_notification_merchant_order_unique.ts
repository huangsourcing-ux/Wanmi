import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "payment_notifications_merchant_order_number_idx";
  CREATE UNIQUE INDEX "payment_notifications_merchant_order_number_idx" ON "payment_notifications" USING btree ("merchant_order_number");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP INDEX "payment_notifications_merchant_order_number_idx";
  CREATE INDEX "payment_notifications_merchant_order_number_idx" ON "payment_notifications" USING btree ("merchant_order_number");`)
}
