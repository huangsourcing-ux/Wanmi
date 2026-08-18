import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_orders_payment_channel" ADD VALUE 'balance';`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM "orders" WHERE "payment_channel"::text = 'balance') THEN
       RAISE EXCEPTION 'cannot roll back D9-B-3 while balance-payment orders exist';
     END IF;
   END
   $$;
   ALTER TABLE "orders" ALTER COLUMN "payment_channel" SET DATA TYPE text;
  DROP TYPE "public"."enum_orders_payment_channel";
  CREATE TYPE "public"."enum_orders_payment_channel" AS ENUM('native', 'h5');
  ALTER TABLE "orders" ALTER COLUMN "payment_channel" SET DATA TYPE "public"."enum_orders_payment_channel" USING "payment_channel"::"public"."enum_orders_payment_channel";`)
}
