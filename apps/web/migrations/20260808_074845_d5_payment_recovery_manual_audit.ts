import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_payment_notification_archives_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_payment_notification_archives_processing_status" AS ENUM('pending', 'processed', 'failed');
  CREATE TYPE "public"."enum_order_manual_actions_action_type" AS ENUM('special_refund', 'invoice_note');
  CREATE TYPE "public"."enum_order_manual_actions_currency" AS ENUM('CNY');
  CREATE TABLE "payment_notification_archives" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"notification_id" varchar NOT NULL,
  	"order_id" integer,
  	"payload_digest" varchar NOT NULL,
  	"merchant_order_number" varchar NOT NULL,
  	"wechat_transaction_id" varchar NOT NULL,
  	"amount_minor" numeric NOT NULL,
  	"currency" "enum_payment_notification_archives_currency" NOT NULL,
  	"paid_at" timestamp(3) with time zone NOT NULL,
  	"received_at" timestamp(3) with time zone NOT NULL,
  	"verified_at" timestamp(3) with time zone NOT NULL,
  	"signature_verified" boolean DEFAULT true NOT NULL,
  	"processing_status" "enum_payment_notification_archives_processing_status" DEFAULT 'pending' NOT NULL,
  	"last_processed_at" timestamp(3) with time zone,
  	"last_replay_at" timestamp(3) with time zone,
  	"replay_count" numeric DEFAULT 0 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "order_manual_actions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"action_key" varchar NOT NULL,
  	"order_id" integer NOT NULL,
  	"action_type" "enum_order_manual_actions_action_type" NOT NULL,
  	"amount_minor" numeric,
  	"currency" "enum_order_manual_actions_currency",
  	"reason" varchar NOT NULL,
  	"evidence" jsonb NOT NULL,
  	"operator_id" integer NOT NULL,
  	"recorded_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "payment_notification_archives_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "order_manual_actions_id" integer;
  ALTER TABLE "payment_notification_archives" ADD CONSTRAINT "payment_notification_archives_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "order_manual_actions" ADD CONSTRAINT "order_manual_actions_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "order_manual_actions" ADD CONSTRAINT "order_manual_actions_operator_id_admins_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "payment_notification_archives_notification_id_idx" ON "payment_notification_archives" USING btree ("notification_id");
  CREATE INDEX "payment_notification_archives_order_idx" ON "payment_notification_archives" USING btree ("order_id");
  CREATE INDEX "payment_notification_archives_updated_at_idx" ON "payment_notification_archives" USING btree ("updated_at");
  CREATE INDEX "payment_notification_archives_created_at_idx" ON "payment_notification_archives" USING btree ("created_at");
  CREATE UNIQUE INDEX "order_manual_actions_action_key_idx" ON "order_manual_actions" USING btree ("action_key");
  CREATE INDEX "order_manual_actions_order_idx" ON "order_manual_actions" USING btree ("order_id");
  CREATE INDEX "order_manual_actions_operator_idx" ON "order_manual_actions" USING btree ("operator_id");
  CREATE INDEX "order_manual_actions_updated_at_idx" ON "order_manual_actions" USING btree ("updated_at");
  CREATE INDEX "order_manual_actions_created_at_idx" ON "order_manual_actions" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_payment_notification_archiv_fk" FOREIGN KEY ("payment_notification_archives_id") REFERENCES "public"."payment_notification_archives"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_order_manual_actions_fk" FOREIGN KEY ("order_manual_actions_id") REFERENCES "public"."order_manual_actions"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_payment_notification_archi_idx" ON "payload_locked_documents_rels" USING btree ("payment_notification_archives_id");
  CREATE INDEX "payload_locked_documents_rels_order_manual_actions_id_idx" ON "payload_locked_documents_rels" USING btree ("order_manual_actions_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_payment_notification_archiv_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_order_manual_actions_fk";
  DROP INDEX "payload_locked_documents_rels_payment_notification_archi_idx";
  DROP INDEX "payload_locked_documents_rels_order_manual_actions_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "payment_notification_archives_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "order_manual_actions_id";
  ALTER TABLE "payment_notification_archives" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "order_manual_actions" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "payment_notification_archives" CASCADE;
  DROP TABLE "order_manual_actions" CASCADE;
  DROP TYPE "public"."enum_payment_notification_archives_currency";
  DROP TYPE "public"."enum_payment_notification_archives_processing_status";
  DROP TYPE "public"."enum_order_manual_actions_action_type";
  DROP TYPE "public"."enum_order_manual_actions_currency";`)
}
