import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_vip_spend_entries_entry_type" AS ENUM('succeeded_order', 'order_reversal', 'data_correction', 'fraud_reversal');
  CREATE TYPE "public"."enum_vip_spend_entries_payment_channel" AS ENUM('native', 'h5', 'balance');
  CREATE TYPE "public"."enum_vip_tier_events_event_type" AS ENUM('tier_achievement', 'tier_correction');
  CREATE TYPE "public"."enum_vip_tier_events_source" AS ENUM('natural_achievement', 'operational_promotion', 'data_correction', 'fraud_reversal');
  ALTER TYPE "public"."enum_notification_outbox_events_notification_type" ADD VALUE 'vip_benefit_change_advance' BEFORE 'product_updates';
  CREATE TABLE "vip_tier_rule_versions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"version" numeric NOT NULL,
  	"schema_version" numeric DEFAULT 1 NOT NULL,
  	"effective_at" timestamp(3) with time zone NOT NULL,
  	"notice_published_at" timestamp(3) with time zone,
  	"changed_by" varchar NOT NULL,
  	"change_note" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "vip_tier_rule_levels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"rule_version_id" integer NOT NULL,
  	"version_number" numeric NOT NULL,
  	"tier_code" varchar NOT NULL,
  	"tier_rank" numeric NOT NULL,
  	"display_name" varchar NOT NULL,
  	"threshold_fen" numeric NOT NULL,
  	"quota_benefits" jsonb NOT NULL,
  	"service_content" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "vip_spend_entries" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"entry_key" varchar NOT NULL,
  	"customer_id" integer,
  	"source_order_id" integer,
  	"entry_type" "enum_vip_spend_entries_entry_type" NOT NULL,
  	"payment_channel" "enum_vip_spend_entries_payment_channel",
  	"amount_fen" numeric NOT NULL,
  	"approval_request_id" integer,
  	"reference" varchar NOT NULL,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "vip_tier_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"customer_id" integer,
  	"event_type" "enum_vip_tier_events_event_type" NOT NULL,
  	"source" "enum_vip_tier_events_source" NOT NULL,
  	"trigger_order_id" integer,
  	"rule_version_id" integer,
  	"rule_version_number" numeric NOT NULL,
  	"tier_code" varchar,
  	"tier_rank" numeric NOT NULL,
  	"tier_name_snapshot" varchar NOT NULL,
  	"quota_benefits_snapshot" jsonb NOT NULL,
  	"service_content_snapshot" varchar NOT NULL,
  	"cumulative_spend_fen_snapshot" numeric NOT NULL,
  	"previous_tier_rank" numeric NOT NULL,
  	"reason" varchar NOT NULL,
  	"approval_request_id" integer,
  	"correction_reference" varchar,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "vip_tier_appeals" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"appeal_key" varchar NOT NULL,
  	"customer_id" integer,
  	"tier_event_id" integer NOT NULL,
  	"statement" varchar NOT NULL,
  	"submitted_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "vip_tier_rule_levels" ADD CONSTRAINT "vip_tier_rule_levels_rule_version_id_vip_tier_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."vip_tier_rule_versions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_spend_entries" ADD CONSTRAINT "vip_spend_entries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_spend_entries" ADD CONSTRAINT "vip_spend_entries_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_spend_entries" ADD CONSTRAINT "vip_spend_entries_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_tier_events" ADD CONSTRAINT "vip_tier_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_tier_events" ADD CONSTRAINT "vip_tier_events_trigger_order_id_orders_id_fk" FOREIGN KEY ("trigger_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_tier_events" ADD CONSTRAINT "vip_tier_events_rule_version_id_vip_tier_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."vip_tier_rule_versions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_tier_events" ADD CONSTRAINT "vip_tier_events_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_tier_appeals" ADD CONSTRAINT "vip_tier_appeals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "vip_tier_appeals" ADD CONSTRAINT "vip_tier_appeals_tier_event_id_vip_tier_events_id_fk" FOREIGN KEY ("tier_event_id") REFERENCES "public"."vip_tier_events"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "vip_tier_rule_versions_effective_at_idx" ON "vip_tier_rule_versions" USING btree ("effective_at");
  CREATE INDEX "vip_tier_rule_versions_notice_published_at_idx" ON "vip_tier_rule_versions" USING btree ("notice_published_at");
  CREATE INDEX "vip_tier_rule_versions_updated_at_idx" ON "vip_tier_rule_versions" USING btree ("updated_at");
  CREATE INDEX "vip_tier_rule_versions_created_at_idx" ON "vip_tier_rule_versions" USING btree ("created_at");
  CREATE UNIQUE INDEX "version_1_idx" ON "vip_tier_rule_versions" USING btree ("version");
  CREATE INDEX "effectiveAt_version_idx" ON "vip_tier_rule_versions" USING btree ("effective_at","version");
  CREATE INDEX "vip_tier_rule_levels_rule_version_idx" ON "vip_tier_rule_levels" USING btree ("rule_version_id");
  CREATE INDEX "vip_tier_rule_levels_updated_at_idx" ON "vip_tier_rule_levels" USING btree ("updated_at");
  CREATE INDEX "vip_tier_rule_levels_created_at_idx" ON "vip_tier_rule_levels" USING btree ("created_at");
  CREATE UNIQUE INDEX "ruleVersion_tierRank_idx" ON "vip_tier_rule_levels" USING btree ("rule_version_id","tier_rank");
  CREATE UNIQUE INDEX "ruleVersion_tierCode_idx" ON "vip_tier_rule_levels" USING btree ("rule_version_id","tier_code");
  CREATE UNIQUE INDEX "vip_spend_entries_entry_key_idx" ON "vip_spend_entries" USING btree ("entry_key");
  CREATE INDEX "vip_spend_entries_customer_idx" ON "vip_spend_entries" USING btree ("customer_id");
  CREATE INDEX "vip_spend_entries_source_order_idx" ON "vip_spend_entries" USING btree ("source_order_id");
  CREATE INDEX "vip_spend_entries_approval_request_idx" ON "vip_spend_entries" USING btree ("approval_request_id");
  CREATE INDEX "vip_spend_entries_occurred_at_idx" ON "vip_spend_entries" USING btree ("occurred_at");
  CREATE INDEX "vip_spend_entries_updated_at_idx" ON "vip_spend_entries" USING btree ("updated_at");
  CREATE INDEX "vip_spend_entries_created_at_idx" ON "vip_spend_entries" USING btree ("created_at");
  CREATE UNIQUE INDEX "sourceOrder_entryType_idx" ON "vip_spend_entries" USING btree ("source_order_id","entry_type");
  CREATE UNIQUE INDEX "vip_tier_events_event_key_idx" ON "vip_tier_events" USING btree ("event_key");
  CREATE INDEX "vip_tier_events_customer_idx" ON "vip_tier_events" USING btree ("customer_id");
  CREATE INDEX "vip_tier_events_trigger_order_idx" ON "vip_tier_events" USING btree ("trigger_order_id");
  CREATE INDEX "vip_tier_events_rule_version_idx" ON "vip_tier_events" USING btree ("rule_version_id");
  CREATE INDEX "vip_tier_events_approval_request_idx" ON "vip_tier_events" USING btree ("approval_request_id");
  CREATE INDEX "vip_tier_events_occurred_at_idx" ON "vip_tier_events" USING btree ("occurred_at");
  CREATE INDEX "vip_tier_events_updated_at_idx" ON "vip_tier_events" USING btree ("updated_at");
  CREATE INDEX "vip_tier_events_created_at_idx" ON "vip_tier_events" USING btree ("created_at");
  CREATE INDEX "customer_tierRank_occurredAt_idx" ON "vip_tier_events" USING btree ("customer_id","tier_rank","occurred_at");
  CREATE UNIQUE INDEX "vip_tier_appeals_appeal_key_idx" ON "vip_tier_appeals" USING btree ("appeal_key");
  CREATE INDEX "vip_tier_appeals_customer_idx" ON "vip_tier_appeals" USING btree ("customer_id");
  CREATE INDEX "vip_tier_appeals_tier_event_idx" ON "vip_tier_appeals" USING btree ("tier_event_id");
  CREATE INDEX "vip_tier_appeals_submitted_at_idx" ON "vip_tier_appeals" USING btree ("submitted_at");
  CREATE INDEX "vip_tier_appeals_updated_at_idx" ON "vip_tier_appeals" USING btree ("updated_at");
  CREATE INDEX "vip_tier_appeals_created_at_idx" ON "vip_tier_appeals" USING btree ("created_at");
  CREATE UNIQUE INDEX "customer_tierEvent_idx" ON "vip_tier_appeals" USING btree ("customer_id","tier_event_id");`)

  await db.execute(sql`
    ALTER TABLE "notification_outbox_events" DROP CONSTRAINT "notification_outbox_events_category_type_valid";
    ALTER TABLE "notification_outbox_events" ADD CONSTRAINT "notification_outbox_events_category_type_valid" CHECK (
      ("category" = 'transactional' AND "notification_type"::text IN (
        'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed',
        'invitation_reward_withheld', 'vip_benefit_change_advance'
      )) OR
      ("category" = 'marketing' AND "notification_type"::text IN ('product_updates', 'promotions'))
    );
    ALTER TABLE "vip_tier_rule_versions" ADD CONSTRAINT "vip_tier_rule_versions_values_valid" CHECK (
      "version" = trunc("version") AND "version" BETWEEN 1 AND 9007199254740991 AND
      "schema_version" = 1 AND
      ("notice_published_at" IS NULL OR "notice_published_at" <= "effective_at") AND
      length(trim("changed_by")) > 0 AND length(trim("change_note")) >= 8
    );
    ALTER TABLE "vip_tier_rule_levels" ADD CONSTRAINT "vip_tier_rule_levels_values_valid" CHECK (
      "version_number" = trunc("version_number") AND "version_number" BETWEEN 1 AND 9007199254740991 AND
      "tier_rank" = trunc("tier_rank") AND "tier_rank" BETWEEN 1 AND 100 AND
      "threshold_fen" = trunc("threshold_fen") AND "threshold_fen" BETWEEN 1 AND 9007199254740991 AND
      "tier_code" ~ '^[a-z][a-z0-9_]{1,31}$' AND
      length(trim("display_name")) > 0 AND length(trim("service_content")) > 0 AND
      jsonb_typeof("quota_benefits") = 'object'
    );
    ALTER TABLE "vip_spend_entries" ADD CONSTRAINT "vip_spend_entries_values_valid" CHECK (
      "amount_fen" = trunc("amount_fen") AND "amount_fen" BETWEEN 1 AND 9007199254740991 AND
      length(trim("reference")) > 0 AND
      (("entry_type" = 'succeeded_order' AND
        "payment_channel" IS NOT NULL AND "approval_request_id" IS NULL) OR
       ("entry_type" = 'order_reversal' AND
        "payment_channel" IS NULL AND "approval_request_id" IS NULL) OR
       ("entry_type" IN ('data_correction', 'fraud_reversal') AND
        "payment_channel" IS NULL AND "approval_request_id" IS NOT NULL))
    );
    ALTER TABLE "vip_tier_events" ADD CONSTRAINT "vip_tier_events_values_valid" CHECK (
      "rule_version_number" = trunc("rule_version_number") AND
      "rule_version_number" BETWEEN 0 AND 9007199254740991 AND
      "tier_rank" = trunc("tier_rank") AND "tier_rank" BETWEEN 0 AND 100 AND
      "previous_tier_rank" = trunc("previous_tier_rank") AND "previous_tier_rank" BETWEEN 0 AND 100 AND
      "cumulative_spend_fen_snapshot" = trunc("cumulative_spend_fen_snapshot") AND
      "cumulative_spend_fen_snapshot" BETWEEN 0 AND 9007199254740991 AND
      length(trim("tier_name_snapshot")) > 0 AND length(trim("service_content_snapshot")) > 0 AND
      length(trim("reason")) > 0 AND jsonb_typeof("quota_benefits_snapshot") = 'object' AND
      (("tier_rank" = 0 AND "tier_code" IS NULL) OR
       ("tier_rank" > 0 AND "tier_code" ~ '^[a-z][a-z0-9_]{1,31}$')) AND
      (("event_type" = 'tier_achievement' AND
        "source" IN ('natural_achievement', 'operational_promotion') AND
        "rule_version_number" > 0 AND
        "tier_rank" > "previous_tier_rank" AND "approval_request_id" IS NULL AND
        "correction_reference" IS NULL AND
        (("source" = 'natural_achievement') OR
         ("source" = 'operational_promotion' AND "trigger_order_id" IS NULL))) OR
       ("event_type" = 'tier_correction' AND
        "source" IN ('data_correction', 'fraud_reversal') AND
        "tier_rank" < "previous_tier_rank" AND "trigger_order_id" IS NULL AND
        "approval_request_id" IS NOT NULL AND "correction_reference" IS NOT NULL AND
        length(trim("correction_reference")) > 0))
    );
    ALTER TABLE "vip_tier_appeals" ADD CONSTRAINT "vip_tier_appeals_values_valid" CHECK (
      length(trim("appeal_key")) > 0 AND length(trim("statement")) >= 8
    );
  `)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DO $$
   BEGIN
     IF EXISTS (
       SELECT 1 FROM "notification_outbox_events"
       WHERE "notification_type" = 'vip_benefit_change_advance'
     ) THEN
       RAISE EXCEPTION 'cannot roll back D9-E-3 while VIP advance notifications exist';
     END IF;
   END $$;
  ALTER TABLE "notification_outbox_events" DROP CONSTRAINT "notification_outbox_events_category_type_valid";
  DROP TABLE "vip_tier_rule_versions" CASCADE;
  DROP TABLE "vip_tier_rule_levels" CASCADE;
  DROP TABLE "vip_spend_entries" CASCADE;
  DROP TABLE "vip_tier_events" CASCADE;
  DROP TABLE "vip_tier_appeals" CASCADE;
  ALTER TABLE "notification_outbox_events" ALTER COLUMN "notification_type" SET DATA TYPE text;
  DROP TYPE "public"."enum_notification_outbox_events_notification_type";
  CREATE TYPE "public"."enum_notification_outbox_events_notification_type" AS ENUM('admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed', 'invitation_reward_withheld', 'product_updates', 'promotions');
  ALTER TABLE "notification_outbox_events" ALTER COLUMN "notification_type" SET DATA TYPE "public"."enum_notification_outbox_events_notification_type" USING "notification_type"::"public"."enum_notification_outbox_events_notification_type";
  ALTER TABLE "notification_outbox_events" ADD CONSTRAINT "notification_outbox_events_category_type_valid" CHECK (
    ("category" = 'transactional' AND "notification_type"::text IN (
      'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed',
      'invitation_reward_withheld'
    )) OR
    ("category" = 'marketing' AND "notification_type"::text IN ('product_updates', 'promotions'))
  );
  DROP TYPE "public"."enum_vip_spend_entries_entry_type";
  DROP TYPE "public"."enum_vip_spend_entries_payment_channel";
  DROP TYPE "public"."enum_vip_tier_events_event_type";
  DROP TYPE "public"."enum_vip_tier_events_source";`)
}
