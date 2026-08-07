import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_ad_creatives_target_check_status" AS ENUM('pending', 'reachable', 'unreachable', 'unsafe');
  CREATE TYPE "public"."enum_ad_creatives_target_check_failure" AS ENUM('none', 'not_allowlisted', 'restricted_address', 'unreachable', 'http_error');
  CREATE TYPE "public"."enum_first_party_events_conversion_type" AS ENUM('landing_viewed');
  ALTER TYPE "public"."enum_first_party_events_event" ADD VALUE 'ad_requested';
  ALTER TYPE "public"."enum_first_party_events_event" ADD VALUE 'ad_served';
  ALTER TYPE "public"."enum_first_party_events_event" ADD VALUE 'ad_viewable';
  ALTER TYPE "public"."enum_first_party_events_event" ADD VALUE 'ad_clicked';
  ALTER TYPE "public"."enum_first_party_events_event" ADD VALUE 'ad_converted';
  ALTER TYPE "public"."enum_first_party_events_page_type" ADD VALUE 'content' BEFORE 'help';
  ALTER TYPE "public"."enum_first_party_events_page_type" ADD VALUE 'tld' BEFORE 'help';
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'advertisingMaintenance' BEFORE 'commerceFulfillment';
  CREATE TABLE "payload_jobs_stats" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"stats" jsonb,
  	"updated_at" timestamp(3) with time zone,
  	"created_at" timestamp(3) with time zone
  );
  
  ALTER TABLE "ad_creatives" ADD COLUMN "target_check_status" "enum_ad_creatives_target_check_status" DEFAULT 'pending' NOT NULL;
  ALTER TABLE "ad_creatives" ADD COLUMN "target_check_failure" "enum_ad_creatives_target_check_failure" DEFAULT 'none' NOT NULL;
  ALTER TABLE "ad_creatives" ADD COLUMN "target_checked_at" timestamp(3) with time zone;
  ALTER TABLE "first_party_events" ADD COLUMN "campaign_id" varchar;
  ALTER TABLE "first_party_events" ADD COLUMN "placement_code" varchar;
  ALTER TABLE "first_party_events" ADD COLUMN "conversion_type" "enum_first_party_events_conversion_type";
  ALTER TABLE "payload_jobs" ADD COLUMN "meta" jsonb;
  UPDATE "ad_creatives"
  SET
    "target_check_status" = 'reachable',
    "target_check_failure" = 'none',
    "target_checked_at" = NOW()
  WHERE "status" = 'approved' AND "target_type" = 'internal';
  CREATE INDEX "ad_creatives_target_check_status_idx" ON "ad_creatives" USING btree ("target_check_status");
  CREATE INDEX "ad_creatives_target_checked_at_idx" ON "ad_creatives" USING btree ("target_checked_at");
  CREATE INDEX "campaignId_event_createdAt_idx" ON "first_party_events" USING btree ("campaign_id","event","created_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DELETE FROM "first_party_events"
  WHERE "event" IN ('ad_requested', 'ad_served', 'ad_viewable', 'ad_clicked', 'ad_converted')
     OR "page_type" IN ('content', 'tld');
  DELETE FROM "payload_jobs" WHERE "workflow_slug"::text = 'advertisingMaintenance';
  ALTER TABLE "payload_jobs_stats" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "payload_jobs_stats" CASCADE;
  ALTER TABLE "first_party_events" ALTER COLUMN "event" SET DATA TYPE text;
  DROP TYPE "public"."enum_first_party_events_event";
  CREATE TYPE "public"."enum_first_party_events_event" AS ENUM('page_viewed', 'tool_submitted', 'tool_completed', 'tool_failed');
  ALTER TABLE "first_party_events" ALTER COLUMN "event" SET DATA TYPE "public"."enum_first_party_events_event" USING "event"::"public"."enum_first_party_events_event";
  ALTER TABLE "first_party_events" ALTER COLUMN "page_type" SET DATA TYPE text;
  DROP TYPE "public"."enum_first_party_events_page_type";
  CREATE TYPE "public"."enum_first_party_events_page_type" AS ENUM('home', 'tool_index', 'tool', 'pricing', 'content_index', 'help', 'legal', 'other');
  ALTER TABLE "first_party_events" ALTER COLUMN "page_type" SET DATA TYPE "public"."enum_first_party_events_page_type" USING "page_type"::"public"."enum_first_party_events_page_type";
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'commerceFulfillment');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "ad_creatives_target_check_status_idx";
  DROP INDEX "ad_creatives_target_checked_at_idx";
  DROP INDEX "campaignId_event_createdAt_idx";
  ALTER TABLE "ad_creatives" DROP COLUMN "target_check_status";
  ALTER TABLE "ad_creatives" DROP COLUMN "target_check_failure";
  ALTER TABLE "ad_creatives" DROP COLUMN "target_checked_at";
  ALTER TABLE "first_party_events" DROP COLUMN "campaign_id";
  ALTER TABLE "first_party_events" DROP COLUMN "placement_code";
  ALTER TABLE "first_party_events" DROP COLUMN "conversion_type";
  ALTER TABLE "payload_jobs" DROP COLUMN "meta";
  DROP TYPE "public"."enum_ad_creatives_target_check_status";
  DROP TYPE "public"."enum_ad_creatives_target_check_failure";
  DROP TYPE "public"."enum_first_party_events_conversion_type";`)
}
