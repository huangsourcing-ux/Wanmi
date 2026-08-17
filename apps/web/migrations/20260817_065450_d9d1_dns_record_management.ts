import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_dns_record_changes_operation" AS ENUM('add', 'modify', 'delete', 'pause', 'resume');
  CREATE TYPE "public"."enum_dns_record_changes_event" AS ENUM('requested', 'confirmed', 'failed', 'pending_query');
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'dns_record_add';
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'dns_record_modify';
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'dns_record_delete';
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'dns_record_pause';
  CREATE TABLE "dns_record_changes" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"operation" "enum_dns_record_changes_operation" NOT NULL,
  	"event" "enum_dns_record_changes_event" NOT NULL,
  	"provider_record_id" varchar,
  	"before_record" jsonb,
  	"requested_record" jsonb,
  	"confirmed_record" jsonb,
  	"provider_operation_id" integer,
  	"operation_key" varchar,
  	"batch_key" varchar,
  	"error_code" varchar,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"trace_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "domain_assets" ADD COLUMN "dns_mutation_lease_key" varchar;
  ALTER TABLE "domain_assets" ADD COLUMN "dns_mutation_lease_expires_at" timestamp(3) with time zone;
  ALTER TABLE "domain_assets" ADD COLUMN "dns_change_window_started_at" timestamp(3) with time zone;
  ALTER TABLE "domain_assets" ADD COLUMN "dns_change_count" numeric DEFAULT 0;
  ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "dns_record_changes" ADD CONSTRAINT "dns_record_changes_provider_operation_id_provider_operations_id_fk" FOREIGN KEY ("provider_operation_id") REFERENCES "public"."provider_operations"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "dns_record_changes_event_key_idx" ON "dns_record_changes" USING btree ("event_key");
  CREATE INDEX "dns_record_changes_customer_idx" ON "dns_record_changes" USING btree ("customer_id");
  CREATE INDEX "dns_record_changes_asset_idx" ON "dns_record_changes" USING btree ("asset_id");
  CREATE INDEX "dns_record_changes_provider_record_id_idx" ON "dns_record_changes" USING btree ("provider_record_id");
  CREATE INDEX "dns_record_changes_provider_operation_idx" ON "dns_record_changes" USING btree ("provider_operation_id");
  CREATE INDEX "dns_record_changes_operation_key_idx" ON "dns_record_changes" USING btree ("operation_key");
  CREATE INDEX "dns_record_changes_batch_key_idx" ON "dns_record_changes" USING btree ("batch_key");
  CREATE INDEX "dns_record_changes_error_code_idx" ON "dns_record_changes" USING btree ("error_code");
  CREATE INDEX "dns_record_changes_occurred_at_idx" ON "dns_record_changes" USING btree ("occurred_at");
  CREATE INDEX "dns_record_changes_trace_id_idx" ON "dns_record_changes" USING btree ("trace_id");
  CREATE INDEX "dns_record_changes_updated_at_idx" ON "dns_record_changes" USING btree ("updated_at");
  CREATE INDEX "dns_record_changes_created_at_idx" ON "dns_record_changes" USING btree ("created_at");
  CREATE INDEX "asset_occurredAt_idx" ON "dns_record_changes" USING btree ("asset_id","occurred_at");
  CREATE INDEX "customer_occurredAt_1_idx" ON "dns_record_changes" USING btree ("customer_id","occurred_at");
  CREATE INDEX "domain_assets_dns_mutation_lease_key_idx" ON "domain_assets" USING btree ("dns_mutation_lease_key");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "dns_record_changes" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "dns_record_changes" CASCADE;
  DELETE FROM "provider_operations"
  WHERE "operation"::text IN ('dns_record_add', 'dns_record_modify', 'dns_record_delete', 'dns_record_pause');
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE text;
  DROP TYPE "public"."enum_provider_operations_operation";
  CREATE TYPE "public"."enum_provider_operations_operation" AS ENUM('realname', 'register', 'renew', 'refund', 'nameserver', 'query');
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE "public"."enum_provider_operations_operation" USING "operation"::"public"."enum_provider_operations_operation";
  DROP INDEX "domain_assets_dns_mutation_lease_key_idx";
  ALTER TABLE "domain_assets" DROP COLUMN "dns_mutation_lease_key";
  ALTER TABLE "domain_assets" DROP COLUMN "dns_mutation_lease_expires_at";
  ALTER TABLE "domain_assets" DROP COLUMN "dns_change_window_started_at";
  ALTER TABLE "domain_assets" DROP COLUMN "dns_change_count";
  DROP TYPE "public"."enum_dns_record_changes_operation";
  DROP TYPE "public"."enum_dns_record_changes_event";`)
}
