import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_account_recovery_records_unavailable_providers" AS ENUM('phone', 'wechat');
  CREATE TYPE "public"."enum_account_recovery_records_event_type" AS ENUM('request_submitted', 'review_concluded');
  CREATE TYPE "public"."enum_account_recovery_records_conclusion" AS ENUM('approved', 'rejected');
  CREATE TABLE "account_recovery_records_unavailable_providers" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_account_recovery_records_unavailable_providers",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "account_recovery_records" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"record_key" varchar NOT NULL,
  	"request_key" varchar NOT NULL,
  	"event_type" "enum_account_recovery_records_event_type" NOT NULL,
  	"customer_id" integer NOT NULL,
  	"manual_review_id" integer NOT NULL,
  	"realname_template_id" integer,
  	"order_id" integer,
  	"payment_notification_id" integer,
  	"reviewer_id" integer,
  	"conclusion" "enum_account_recovery_records_conclusion",
  	"decision_note" varchar,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"cooldown_started_at" timestamp(3) with time zone,
  	"cooldown_ends_at" timestamp(3) with time zone,
  	"revoked_session_count" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "manual_reviews" ADD COLUMN "payment_notification_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "account_recovery_records_id" integer;
  ALTER TABLE "account_recovery_records_unavailable_providers" ADD CONSTRAINT "account_recovery_records_unavailable_providers_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."account_recovery_records"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "account_recovery_records" ADD CONSTRAINT "account_recovery_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "account_recovery_records" ADD CONSTRAINT "account_recovery_records_manual_review_id_manual_reviews_id_fk" FOREIGN KEY ("manual_review_id") REFERENCES "public"."manual_reviews"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "account_recovery_records" ADD CONSTRAINT "account_recovery_records_realname_template_id_realname_templates_id_fk" FOREIGN KEY ("realname_template_id") REFERENCES "public"."realname_templates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "account_recovery_records" ADD CONSTRAINT "account_recovery_records_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "account_recovery_records" ADD CONSTRAINT "account_recovery_records_payment_notification_id_payment_notifications_id_fk" FOREIGN KEY ("payment_notification_id") REFERENCES "public"."payment_notifications"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "account_recovery_records" ADD CONSTRAINT "account_recovery_records_reviewer_id_admins_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "account_recovery_records_unavailable_providers_order_idx" ON "account_recovery_records_unavailable_providers" USING btree ("order");
  CREATE INDEX "account_recovery_records_unavailable_providers_parent_idx" ON "account_recovery_records_unavailable_providers" USING btree ("parent_id");
  CREATE UNIQUE INDEX "account_recovery_records_record_key_idx" ON "account_recovery_records" USING btree ("record_key");
  CREATE INDEX "account_recovery_records_request_key_idx" ON "account_recovery_records" USING btree ("request_key");
  CREATE INDEX "account_recovery_records_customer_idx" ON "account_recovery_records" USING btree ("customer_id");
  CREATE INDEX "account_recovery_records_manual_review_idx" ON "account_recovery_records" USING btree ("manual_review_id");
  CREATE INDEX "account_recovery_records_realname_template_idx" ON "account_recovery_records" USING btree ("realname_template_id");
  CREATE INDEX "account_recovery_records_order_idx" ON "account_recovery_records" USING btree ("order_id");
  CREATE INDEX "account_recovery_records_payment_notification_idx" ON "account_recovery_records" USING btree ("payment_notification_id");
  CREATE INDEX "account_recovery_records_reviewer_idx" ON "account_recovery_records" USING btree ("reviewer_id");
  CREATE INDEX "account_recovery_records_occurred_at_idx" ON "account_recovery_records" USING btree ("occurred_at");
  CREATE INDEX "account_recovery_records_cooldown_started_at_idx" ON "account_recovery_records" USING btree ("cooldown_started_at");
  CREATE INDEX "account_recovery_records_cooldown_ends_at_idx" ON "account_recovery_records" USING btree ("cooldown_ends_at");
  CREATE INDEX "account_recovery_records_updated_at_idx" ON "account_recovery_records" USING btree ("updated_at");
  CREATE INDEX "account_recovery_records_created_at_idx" ON "account_recovery_records" USING btree ("created_at");
  CREATE INDEX "customer_occurredAt_idx" ON "account_recovery_records" USING btree ("customer_id","occurred_at");
  CREATE INDEX "manualReview_eventType_idx" ON "account_recovery_records" USING btree ("manual_review_id","event_type");
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_payment_notification_id_payment_notifications_id_fk" FOREIGN KEY ("payment_notification_id") REFERENCES "public"."payment_notifications"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_account_recovery_records_fk" FOREIGN KEY ("account_recovery_records_id") REFERENCES "public"."account_recovery_records"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "manual_reviews_payment_notification_idx" ON "manual_reviews" USING btree ("payment_notification_id");
  CREATE INDEX "payload_locked_documents_rels_account_recovery_records_i_idx" ON "payload_locked_documents_rels" USING btree ("account_recovery_records_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "account_recovery_records_unavailable_providers" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "account_recovery_records" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "account_recovery_records_unavailable_providers" CASCADE;
  DROP TABLE "account_recovery_records" CASCADE;
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_payment_notification_id_payment_notifications_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_account_recovery_records_fk";
  
  DROP INDEX "manual_reviews_payment_notification_idx";
  DROP INDEX "payload_locked_documents_rels_account_recovery_records_i_idx";
  ALTER TABLE "manual_reviews" DROP COLUMN "payment_notification_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "account_recovery_records_id";
  DROP TYPE "public"."enum_account_recovery_records_unavailable_providers";
  DROP TYPE "public"."enum_account_recovery_records_event_type";
  DROP TYPE "public"."enum_account_recovery_records_conclusion";`)
}
