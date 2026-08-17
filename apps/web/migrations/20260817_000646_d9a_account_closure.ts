import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_account_closure_requests_event_type" AS ENUM('requested', 'blockers_refreshed', 'revoked', 'executed');
  CREATE TYPE "public"."enum_account_closure_requests_actor_type" AS ENUM('customer', 'admin');
  CREATE TYPE "public"."enum_order_manual_actions_invoice_status" AS ENUM('processing', 'completed', 'cancelled');
  CREATE TABLE "account_closure_requests" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"record_key" varchar NOT NULL,
  	"request_key" varchar NOT NULL,
  	"event_type" "enum_account_closure_requests_event_type" NOT NULL,
  	"customer_id" integer NOT NULL,
  	"requested_at" timestamp(3) with time zone NOT NULL,
  	"reason" varchar NOT NULL,
  	"current_blockers" jsonb NOT NULL,
  	"cooldown_started_at" timestamp(3) with time zone NOT NULL,
  	"cooldown_ends_at" timestamp(3) with time zone NOT NULL,
  	"revoked_at" timestamp(3) with time zone,
  	"executed_at" timestamp(3) with time zone,
  	"identity_rebind_allowed_at" timestamp(3) with time zone,
  	"data_retention_result" jsonb,
  	"anonymization_result" jsonb,
  	"actor_type" "enum_account_closure_requests_actor_type" NOT NULL,
  	"actor_id" varchar NOT NULL,
  	"step_up_grant_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "customers" ADD COLUMN "active_account_closure_request_key" varchar;
  ALTER TABLE "customers" ADD COLUMN "account_closure_version" numeric DEFAULT 0;
  ALTER TABLE "customers" ADD COLUMN "account_closure_execution_claimed_at" timestamp(3) with time zone;
  ALTER TABLE "customer_identities" ADD COLUMN "released_identifier_hash" varchar;
  ALTER TABLE "customer_identities" ADD COLUMN "rebind_allowed_at" timestamp(3) with time zone;
  ALTER TABLE "order_manual_actions" ADD COLUMN "invoice_status" "enum_order_manual_actions_invoice_status";
  UPDATE "order_manual_actions"
  SET "invoice_status" = 'processing'
  WHERE "action_type" = 'invoice_note'
    AND "invoice_status" IS NULL;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "account_closure_requests_id" integer;
  ALTER TABLE "account_closure_requests" ADD CONSTRAINT "account_closure_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "account_closure_requests" ADD CONSTRAINT "account_closure_requests_step_up_grant_id_step_up_grants_id_fk" FOREIGN KEY ("step_up_grant_id") REFERENCES "public"."step_up_grants"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "account_closure_requests_record_key_idx" ON "account_closure_requests" USING btree ("record_key");
  CREATE INDEX "account_closure_requests_request_key_idx" ON "account_closure_requests" USING btree ("request_key");
  CREATE INDEX "account_closure_requests_customer_idx" ON "account_closure_requests" USING btree ("customer_id");
  CREATE INDEX "account_closure_requests_requested_at_idx" ON "account_closure_requests" USING btree ("requested_at");
  CREATE INDEX "account_closure_requests_cooldown_started_at_idx" ON "account_closure_requests" USING btree ("cooldown_started_at");
  CREATE INDEX "account_closure_requests_cooldown_ends_at_idx" ON "account_closure_requests" USING btree ("cooldown_ends_at");
  CREATE INDEX "account_closure_requests_revoked_at_idx" ON "account_closure_requests" USING btree ("revoked_at");
  CREATE INDEX "account_closure_requests_executed_at_idx" ON "account_closure_requests" USING btree ("executed_at");
  CREATE INDEX "account_closure_requests_identity_rebind_allowed_at_idx" ON "account_closure_requests" USING btree ("identity_rebind_allowed_at");
  CREATE INDEX "account_closure_requests_step_up_grant_idx" ON "account_closure_requests" USING btree ("step_up_grant_id");
  CREATE INDEX "account_closure_requests_updated_at_idx" ON "account_closure_requests" USING btree ("updated_at");
  CREATE INDEX "account_closure_requests_created_at_idx" ON "account_closure_requests" USING btree ("created_at");
  CREATE INDEX "customer_requestedAt_idx" ON "account_closure_requests" USING btree ("customer_id","requested_at");
  CREATE INDEX "requestKey_eventType_idx" ON "account_closure_requests" USING btree ("request_key","event_type");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_account_closure_requests_fk" FOREIGN KEY ("account_closure_requests_id") REFERENCES "public"."account_closure_requests"("id") ON DELETE cascade ON UPDATE no action;
  CREATE UNIQUE INDEX "customers_active_account_closure_request_key_idx" ON "customers" USING btree ("active_account_closure_request_key");
  CREATE INDEX "customers_account_closure_execution_claimed_at_idx" ON "customers" USING btree ("account_closure_execution_claimed_at");
  CREATE INDEX "customer_identities_released_identifier_hash_idx" ON "customer_identities" USING btree ("released_identifier_hash");
  CREATE INDEX "customer_identities_rebind_allowed_at_idx" ON "customer_identities" USING btree ("rebind_allowed_at");
  CREATE INDEX "order_manual_actions_invoice_status_idx" ON "order_manual_actions" USING btree ("invoice_status");
  CREATE INDEX "payload_locked_documents_rels_account_closure_requests_i_idx" ON "payload_locked_documents_rels" USING btree ("account_closure_requests_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "account_closure_requests" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "account_closure_requests" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_account_closure_requests_fk";
  
  DROP INDEX "customers_active_account_closure_request_key_idx";
  DROP INDEX "customers_account_closure_execution_claimed_at_idx";
  DROP INDEX "customer_identities_released_identifier_hash_idx";
  DROP INDEX "customer_identities_rebind_allowed_at_idx";
  DROP INDEX "order_manual_actions_invoice_status_idx";
  DROP INDEX "payload_locked_documents_rels_account_closure_requests_i_idx";
  ALTER TABLE "customers" DROP COLUMN "active_account_closure_request_key";
  ALTER TABLE "customers" DROP COLUMN "account_closure_version";
  ALTER TABLE "customers" DROP COLUMN "account_closure_execution_claimed_at";
  ALTER TABLE "customer_identities" DROP COLUMN "released_identifier_hash";
  ALTER TABLE "customer_identities" DROP COLUMN "rebind_allowed_at";
  ALTER TABLE "order_manual_actions" DROP COLUMN "invoice_status";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "account_closure_requests_id";
  DROP TYPE "public"."enum_account_closure_requests_event_type";
  DROP TYPE "public"."enum_account_closure_requests_actor_type";
  DROP TYPE "public"."enum_order_manual_actions_invoice_status";`)
}
