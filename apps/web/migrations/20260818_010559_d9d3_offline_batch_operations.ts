import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_domain_batch_operation_events_operation" AS ENUM('nameserver_change');
  CREATE TYPE "public"."enum_domain_batch_operation_events_event" AS ENUM('requested', 'pending_query', 'confirmed', 'failed');
  ALTER TYPE "public"."enum_provider_operations_operation" ADD VALUE 'dns_record_batch_delete' BEFORE 'dns_record_pause';
  CREATE TABLE "domain_batch_operation_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"batch_key" varchar NOT NULL,
  	"item_key" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"nameserver_change_id" integer NOT NULL,
  	"operation" "enum_domain_batch_operation_events_operation" NOT NULL,
  	"event" "enum_domain_batch_operation_events_event" NOT NULL,
  	"reason_code" varchar,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"trace_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "domain_batch_operation_events" ADD CONSTRAINT "domain_batch_operation_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_batch_operation_events" ADD CONSTRAINT "domain_batch_operation_events_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_batch_operation_events" ADD CONSTRAINT "domain_batch_operation_events_nameserver_change_id_nameserver_changes_id_fk" FOREIGN KEY ("nameserver_change_id") REFERENCES "public"."nameserver_changes"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "domain_batch_operation_events_event_key_idx" ON "domain_batch_operation_events" USING btree ("event_key");
  CREATE INDEX "domain_batch_operation_events_batch_key_idx" ON "domain_batch_operation_events" USING btree ("batch_key");
  CREATE INDEX "domain_batch_operation_events_item_key_idx" ON "domain_batch_operation_events" USING btree ("item_key");
  CREATE INDEX "domain_batch_operation_events_customer_idx" ON "domain_batch_operation_events" USING btree ("customer_id");
  CREATE INDEX "domain_batch_operation_events_asset_idx" ON "domain_batch_operation_events" USING btree ("asset_id");
  CREATE INDEX "domain_batch_operation_events_nameserver_change_idx" ON "domain_batch_operation_events" USING btree ("nameserver_change_id");
  CREATE INDEX "domain_batch_operation_events_reason_code_idx" ON "domain_batch_operation_events" USING btree ("reason_code");
  CREATE INDEX "domain_batch_operation_events_occurred_at_idx" ON "domain_batch_operation_events" USING btree ("occurred_at");
  CREATE INDEX "domain_batch_operation_events_trace_id_idx" ON "domain_batch_operation_events" USING btree ("trace_id");
  CREATE INDEX "domain_batch_operation_events_updated_at_idx" ON "domain_batch_operation_events" USING btree ("updated_at");
  CREATE INDEX "domain_batch_operation_events_created_at_idx" ON "domain_batch_operation_events" USING btree ("created_at");
  CREATE INDEX "batchKey_occurredAt_idx" ON "domain_batch_operation_events" USING btree ("batch_key","occurred_at");
  CREATE INDEX "customer_occurredAt_3_idx" ON "domain_batch_operation_events" USING btree ("customer_id","occurred_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "domain_batch_operation_events" CASCADE;
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE text;
  DROP TYPE "public"."enum_provider_operations_operation";
  CREATE TYPE "public"."enum_provider_operations_operation" AS ENUM('realname', 'register', 'renew', 'refund', 'nameserver', 'query', 'dns_record_add', 'dns_record_modify', 'dns_record_delete', 'dns_record_pause', 'domain_management_password', 'domain_contact_update', 'domain_template_transfer');
  ALTER TABLE "provider_operations" ALTER COLUMN "operation" SET DATA TYPE "public"."enum_provider_operations_operation" USING "operation"::"public"."enum_provider_operations_operation";
  DROP TYPE "public"."enum_domain_batch_operation_events_operation";
  DROP TYPE "public"."enum_domain_batch_operation_events_event";`)
}
