import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_orders_payment_channel" AS ENUM('native', 'h5');
  CREATE TYPE "public"."enum_payment_notifications_source" AS ENUM('notification', 'query');
  CREATE TYPE "public"."enum_payment_notifications_confirmation_status" AS ENUM('confirmed', 'mismatch', 'not_paid', 'rejected', 'unknown');
  CREATE TYPE "public"."enum_payment_notifications_currency" AS ENUM('CNY');
  ALTER TABLE "payment_notifications" ALTER COLUMN "wechat_transaction_id" DROP NOT NULL;
  ALTER TABLE "payment_notifications" ALTER COLUMN "merchant_order_number" DROP NOT NULL;
  ALTER TABLE "payment_notifications" ALTER COLUMN "amount_minor" DROP NOT NULL;
  ALTER TABLE "orders" ADD COLUMN "merchant_order_number" varchar;
  ALTER TABLE "orders" ADD COLUMN "payment_channel" "enum_orders_payment_channel";
  ALTER TABLE "orders" ADD COLUMN "payment_expires_at" timestamp(3) with time zone;
  ALTER TABLE "payment_notifications" ADD COLUMN "notification_id" varchar;
  ALTER TABLE "payment_notifications" ADD COLUMN "order_id" integer;
  ALTER TABLE "payment_notifications" ADD COLUMN "source" "enum_payment_notifications_source";
  ALTER TABLE "payment_notifications" ADD COLUMN "confirmation_status" "enum_payment_notifications_confirmation_status";
  ALTER TABLE "payment_notifications" ADD COLUMN "currency" "enum_payment_notifications_currency";
  ALTER TABLE "payment_notifications" ADD COLUMN "paid_at" timestamp(3) with time zone;
  ALTER TABLE "payment_notifications" ADD COLUMN "provider_request_id" varchar;
  UPDATE "payment_notifications"
  SET
    "notification_id" = 'LEGACY-' || "id"::text,
    "source" = 'notification',
    "confirmation_status" = CASE
      WHEN "signature_verified" = true THEN 'confirmed'::"enum_payment_notifications_confirmation_status"
      ELSE 'rejected'::"enum_payment_notifications_confirmation_status"
    END;
  ALTER TABLE "payment_notifications" ALTER COLUMN "notification_id" SET NOT NULL;
  ALTER TABLE "payment_notifications" ALTER COLUMN "source" SET NOT NULL;
  ALTER TABLE "payment_notifications" ALTER COLUMN "confirmation_status" SET NOT NULL;
  ALTER TABLE "payment_notifications" ADD CONSTRAINT "payment_notifications_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "orders_merchant_order_number_idx" ON "orders" USING btree ("merchant_order_number");
  CREATE UNIQUE INDEX "payment_notifications_notification_id_idx" ON "payment_notifications" USING btree ("notification_id");
  CREATE INDEX "payment_notifications_order_idx" ON "payment_notifications" USING btree ("order_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payment_notifications" DROP CONSTRAINT "payment_notifications_order_id_orders_id_fk";
  
  DROP INDEX "orders_merchant_order_number_idx";
  DROP INDEX "payment_notifications_notification_id_idx";
  DROP INDEX "payment_notifications_order_idx";
  ALTER TABLE "payment_notifications" ALTER COLUMN "wechat_transaction_id" SET NOT NULL;
  ALTER TABLE "payment_notifications" ALTER COLUMN "merchant_order_number" SET NOT NULL;
  ALTER TABLE "payment_notifications" ALTER COLUMN "amount_minor" SET NOT NULL;
  ALTER TABLE "orders" DROP COLUMN "merchant_order_number";
  ALTER TABLE "orders" DROP COLUMN "payment_channel";
  ALTER TABLE "orders" DROP COLUMN "payment_expires_at";
  ALTER TABLE "payment_notifications" DROP COLUMN "notification_id";
  ALTER TABLE "payment_notifications" DROP COLUMN "order_id";
  ALTER TABLE "payment_notifications" DROP COLUMN "source";
  ALTER TABLE "payment_notifications" DROP COLUMN "confirmation_status";
  ALTER TABLE "payment_notifications" DROP COLUMN "currency";
  ALTER TABLE "payment_notifications" DROP COLUMN "paid_at";
  ALTER TABLE "payment_notifications" DROP COLUMN "provider_request_id";
  DROP TYPE "public"."enum_orders_payment_channel";
  DROP TYPE "public"."enum_payment_notifications_source";
  DROP TYPE "public"."enum_payment_notifications_confirmation_status";
  DROP TYPE "public"."enum_payment_notifications_currency";`)
}
