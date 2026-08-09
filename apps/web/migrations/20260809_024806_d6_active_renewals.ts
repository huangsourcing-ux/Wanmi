import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_quotes_operation" AS ENUM('registration', 'renewal');
  CREATE TYPE "public"."enum_orders_operation" AS ENUM('registration', 'renewal');
  DROP INDEX "renewals_order_idx";
  ALTER TABLE "quotes" ADD COLUMN "operation" "enum_quotes_operation" DEFAULT 'registration';
  ALTER TABLE "quotes" ADD COLUMN "domain_asset_id" integer;
  ALTER TABLE "quotes" ADD COLUMN "asset_expires_at" timestamp(3) with time zone;
  ALTER TABLE "orders" ADD COLUMN "operation" "enum_orders_operation" DEFAULT 'registration';
  ALTER TABLE "orders" ADD COLUMN "domain_asset_id" integer;
  ALTER TABLE "renewals" ADD COLUMN "previous_expires_at" timestamp(3) with time zone;
  ALTER TABLE "renewals" ADD COLUMN "confirmed_expires_at" timestamp(3) with time zone;
  ALTER TABLE "renewals" ADD COLUMN "provider_operation_key" varchar;
  UPDATE "renewals"
  SET "previous_expires_at" = "domain_assets"."expires_at"
  FROM "domain_assets"
  WHERE "renewals"."asset_id" = "domain_assets"."id";
  ALTER TABLE "renewals" ALTER COLUMN "previous_expires_at" SET NOT NULL;
  ALTER TABLE "quotes" ADD CONSTRAINT "quotes_domain_asset_id_domain_assets_id_fk" FOREIGN KEY ("domain_asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_domain_asset_id_domain_assets_id_fk" FOREIGN KEY ("domain_asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "quotes_domain_asset_idx" ON "quotes" USING btree ("domain_asset_id");
  CREATE INDEX "orders_domain_asset_idx" ON "orders" USING btree ("domain_asset_id");
  CREATE INDEX "renewals_provider_operation_key_idx" ON "renewals" USING btree ("provider_operation_key");
  CREATE UNIQUE INDEX "renewals_order_idx" ON "renewals" USING btree ("order_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "quotes" DROP CONSTRAINT "quotes_domain_asset_id_domain_assets_id_fk";
  
  ALTER TABLE "orders" DROP CONSTRAINT "orders_domain_asset_id_domain_assets_id_fk";
  
  DROP INDEX "quotes_domain_asset_idx";
  DROP INDEX "orders_domain_asset_idx";
  DROP INDEX "renewals_provider_operation_key_idx";
  DROP INDEX "renewals_order_idx";
  CREATE INDEX "renewals_order_idx" ON "renewals" USING btree ("order_id");
  ALTER TABLE "quotes" DROP COLUMN "operation";
  ALTER TABLE "quotes" DROP COLUMN "domain_asset_id";
  ALTER TABLE "quotes" DROP COLUMN "asset_expires_at";
  ALTER TABLE "orders" DROP COLUMN "operation";
  ALTER TABLE "orders" DROP COLUMN "domain_asset_id";
  ALTER TABLE "renewals" DROP COLUMN "previous_expires_at";
  ALTER TABLE "renewals" DROP COLUMN "confirmed_expires_at";
  ALTER TABLE "renewals" DROP COLUMN "provider_operation_key";
  DROP TYPE "public"."enum_quotes_operation";
  DROP TYPE "public"."enum_orders_operation";`)
}
