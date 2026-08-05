import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_first_party_events_event" AS ENUM('page_viewed', 'tool_submitted', 'tool_completed', 'tool_failed');
  CREATE TYPE "public"."enum_first_party_events_page_type" AS ENUM('home', 'tool_index', 'tool', 'pricing', 'content_index', 'help', 'legal', 'other');
  CREATE TYPE "public"."enum_first_party_events_source" AS ENUM('direct', 'internal', 'search', 'social', 'referral');
  CREATE TYPE "public"."enum_first_party_events_device_category" AS ENUM('mobile', 'tablet', 'desktop');
  CREATE TYPE "public"."enum_first_party_events_tool" AS ENUM('domain-search', 'whois', 'dns', 'ssl-check', 'idn', 'pricing');
  CREATE TYPE "public"."enum_first_party_events_input_type" AS ENUM('full_domain', 'keyword', 'unknown');
  CREATE TYPE "public"."enum_first_party_events_result_category" AS ENUM('ready', 'empty', 'partial', 'degraded');
  CREATE TYPE "public"."enum_first_party_events_duration_bucket" AS ENUM('lt_100ms', '100_299ms', '300_999ms', '1000_2999ms', '3000_9999ms', 'gte_10000ms');
  CREATE TYPE "public"."enum_first_party_events_data_source" AS ENUM('local', 'cache', 'westdigital', 'whodat', 'dns', 'tls', 'unknown');
  CREATE TABLE "first_party_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"schema_version" numeric DEFAULT 1 NOT NULL,
  	"event" "enum_first_party_events_event" NOT NULL,
  	"page_type" "enum_first_party_events_page_type",
  	"source" "enum_first_party_events_source",
  	"device_category" "enum_first_party_events_device_category",
  	"tool" "enum_first_party_events_tool",
  	"input_type" "enum_first_party_events_input_type",
  	"from_local_history" boolean,
  	"tld" varchar,
  	"result_category" "enum_first_party_events_result_category",
  	"succeeded" boolean,
  	"duration_bucket" "enum_first_party_events_duration_bucket",
  	"data_source" "enum_first_party_events_data_source",
  	"error_code" varchar,
  	"trace_id" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "first_party_events_id" integer;
  CREATE UNIQUE INDEX "first_party_events_trace_id_idx" ON "first_party_events" USING btree ("trace_id");
  CREATE INDEX "first_party_events_updated_at_idx" ON "first_party_events" USING btree ("updated_at");
  CREATE INDEX "first_party_events_created_at_idx" ON "first_party_events" USING btree ("created_at");
  CREATE INDEX "event_createdAt_idx" ON "first_party_events" USING btree ("event","created_at");
  CREATE INDEX "tool_createdAt_idx" ON "first_party_events" USING btree ("tool","created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_first_party_events_fk" FOREIGN KEY ("first_party_events_id") REFERENCES "public"."first_party_events"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_first_party_events_id_idx" ON "payload_locked_documents_rels" USING btree ("first_party_events_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_first_party_events_fk";
  DROP INDEX "payload_locked_documents_rels_first_party_events_id_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "first_party_events_id";
  ALTER TABLE "first_party_events" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "first_party_events" CASCADE;
  DROP TYPE "public"."enum_first_party_events_event";
  DROP TYPE "public"."enum_first_party_events_page_type";
  DROP TYPE "public"."enum_first_party_events_source";
  DROP TYPE "public"."enum_first_party_events_device_category";
  DROP TYPE "public"."enum_first_party_events_tool";
  DROP TYPE "public"."enum_first_party_events_input_type";
  DROP TYPE "public"."enum_first_party_events_result_category";
  DROP TYPE "public"."enum_first_party_events_duration_bucket";
  DROP TYPE "public"."enum_first_party_events_data_source";`)
}
