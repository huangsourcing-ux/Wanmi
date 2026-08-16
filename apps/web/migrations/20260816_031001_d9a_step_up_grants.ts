import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_sms_challenges_purpose" AS ENUM('login', 'step_up');
  CREATE TYPE "public"."enum_sms_challenges_step_up_purpose" AS ENUM('dns_record_change', 'nameserver_change', 'mx_record_change', 'dns_bulk_delete', 'domain_lock_change', 'realname_change', 'domain_management_password', 'balance_spend', 'account_deletion');
  CREATE TYPE "public"."enum_step_up_grants_purpose" AS ENUM('dns_record_change', 'nameserver_change', 'mx_record_change', 'dns_bulk_delete', 'domain_lock_change', 'realname_change', 'domain_management_password', 'balance_spend', 'account_deletion');
  CREATE TABLE "step_up_grants" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"purpose" "enum_step_up_grants_purpose" NOT NULL,
  	"token_hash" varchar NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"consumed_at" timestamp(3) with time zone,
  	"device_hash" varchar NOT NULL,
  	"ip_hash" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "sms_challenges" ADD COLUMN "purpose" "enum_sms_challenges_purpose" DEFAULT 'login' NOT NULL;
  ALTER TABLE "sms_challenges" ADD COLUMN "step_up_purpose" "enum_sms_challenges_step_up_purpose";
  ALTER TABLE "sms_challenges" ADD COLUMN "customer_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "step_up_grants_id" integer;
  ALTER TABLE "step_up_grants" ADD CONSTRAINT "step_up_grants_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "step_up_grants_customer_idx" ON "step_up_grants" USING btree ("customer_id");
  CREATE INDEX "step_up_grants_purpose_idx" ON "step_up_grants" USING btree ("purpose");
  CREATE UNIQUE INDEX "step_up_grants_token_hash_idx" ON "step_up_grants" USING btree ("token_hash");
  CREATE INDEX "step_up_grants_expires_at_idx" ON "step_up_grants" USING btree ("expires_at");
  CREATE INDEX "step_up_grants_consumed_at_idx" ON "step_up_grants" USING btree ("consumed_at");
  CREATE INDEX "step_up_grants_device_hash_idx" ON "step_up_grants" USING btree ("device_hash");
  CREATE INDEX "step_up_grants_ip_hash_idx" ON "step_up_grants" USING btree ("ip_hash");
  CREATE INDEX "step_up_grants_updated_at_idx" ON "step_up_grants" USING btree ("updated_at");
  CREATE INDEX "step_up_grants_created_at_idx" ON "step_up_grants" USING btree ("created_at");
  CREATE INDEX "customer_purpose_expiresAt_idx" ON "step_up_grants" USING btree ("customer_id","purpose","expires_at");
  ALTER TABLE "sms_challenges" ADD CONSTRAINT "sms_challenges_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_step_up_grants_fk" FOREIGN KEY ("step_up_grants_id") REFERENCES "public"."step_up_grants"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "sms_challenges_purpose_idx" ON "sms_challenges" USING btree ("purpose");
  CREATE INDEX "sms_challenges_step_up_purpose_idx" ON "sms_challenges" USING btree ("step_up_purpose");
  CREATE INDEX "sms_challenges_customer_idx" ON "sms_challenges" USING btree ("customer_id");
  CREATE INDEX "payload_locked_documents_rels_step_up_grants_id_idx" ON "payload_locked_documents_rels" USING btree ("step_up_grants_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "step_up_grants" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "step_up_grants" CASCADE;
  ALTER TABLE "sms_challenges" DROP CONSTRAINT "sms_challenges_customer_id_customers_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_step_up_grants_fk";
  
  DROP INDEX "sms_challenges_purpose_idx";
  DROP INDEX "sms_challenges_step_up_purpose_idx";
  DROP INDEX "sms_challenges_customer_idx";
  DROP INDEX "payload_locked_documents_rels_step_up_grants_id_idx";
  ALTER TABLE "sms_challenges" DROP COLUMN "purpose";
  ALTER TABLE "sms_challenges" DROP COLUMN "step_up_purpose";
  ALTER TABLE "sms_challenges" DROP COLUMN "customer_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "step_up_grants_id";
  DROP TYPE "public"."enum_sms_challenges_purpose";
  DROP TYPE "public"."enum_sms_challenges_step_up_purpose";
  DROP TYPE "public"."enum_step_up_grants_purpose";`)
}
