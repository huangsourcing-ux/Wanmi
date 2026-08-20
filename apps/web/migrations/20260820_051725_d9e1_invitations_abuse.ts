import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_invitation_relationships_bind_source" AS ENUM('registration', 'post_registration', 'legacy_backfill');
  CREATE TYPE "public"."enum_invitation_reward_events_signals" AS ENUM('same_device_hash', 'same_realname_subject', 'same_phone_hash', 'same_payment_account_hash', 'abnormal_invitation_growth');
  CREATE TYPE "public"."enum_invitation_reward_events_event_type" AS ENUM('pending', 'withheld', 'available', 'flagged_after_release');
  ALTER TYPE "public"."enum_points_batches_source_type" ADD VALUE 'invitation_reward';
  ALTER TYPE "public"."enum_notification_outbox_events_notification_type" ADD VALUE 'invitation_reward_withheld' BEFORE 'product_updates';
  ALTER TABLE "notification_outbox_events" DROP CONSTRAINT "notification_outbox_events_category_type_valid";
  ALTER TABLE "notification_outbox_events" ADD CONSTRAINT "notification_outbox_events_category_type_valid" CHECK (
    ("category" = 'transactional' AND "notification_type"::text IN (
      'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed',
      'invitation_reward_withheld'
    )) OR
    ("category" = 'marketing' AND "notification_type"::text IN ('product_updates', 'promotions'))
  );
  CREATE TABLE "invitation_reward_rule_versions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"version" numeric NOT NULL,
  	"schema_version" numeric DEFAULT 1 NOT NULL,
  	"enabled" boolean DEFAULT false NOT NULL,
  	"reward_points" numeric NOT NULL,
  	"reward_expiry_days" numeric NOT NULL,
  	"binding_window_hours" numeric NOT NULL,
  	"effective_at" timestamp(3) with time zone NOT NULL,
  	"changed_by" varchar NOT NULL,
  	"change_note" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "invitation_relationships" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"relationship_key" varchar NOT NULL,
  	"inviter_customer_id" integer NOT NULL,
  	"invitee_customer_id" integer NOT NULL,
  	"bind_source" "enum_invitation_relationships_bind_source" NOT NULL,
  	"invite_code_hash" varchar,
  	"binding_device_hash" varchar,
  	"bound_at" timestamp(3) with time zone NOT NULL,
  	"binding_window_ends_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "invitation_reward_claims" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"claim_key" varchar NOT NULL,
  	"relationship_id" integer NOT NULL,
  	"inviter_customer_id" integer NOT NULL,
  	"invitee_customer_id" integer NOT NULL,
  	"source_order_id" integer NOT NULL,
  	"rule_version_id" integer NOT NULL,
  	"rule_version_number" numeric NOT NULL,
  	"points" numeric NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "invitation_reward_events_signals" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_invitation_reward_events_signals",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "invitation_reward_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"claim_id" integer NOT NULL,
  	"inviter_customer_id" integer NOT NULL,
  	"invitee_customer_id" integer NOT NULL,
  	"event_type" "enum_invitation_reward_events_event_type" NOT NULL,
  	"points_batch_id" integer,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "customers" ADD COLUMN "invite_code_disabled_at" timestamp(3) with time zone;
  ALTER TABLE "payment_notifications" ADD COLUMN "payer_identifier_hash" varchar;
  ALTER TABLE "payment_notification_archives" ADD COLUMN "payer_identifier_hash" varchar;
  ALTER TABLE "wallet_top_up_orders" ADD COLUMN "payer_identifier_hash" varchar;
  ALTER TABLE "points_batches" ADD COLUMN "source_customer_id" integer;
  ALTER TABLE "manual_reviews" ADD COLUMN "invitation_reward_claim_id" integer;
  UPDATE "points_batches" SET "source_customer_id" = "customer_id" WHERE "source_customer_id" IS NULL;
  ALTER TABLE "points_batches" ADD CONSTRAINT "points_batches_invitation_source_customer_required" CHECK (
    "source_type"::text <> 'invitation_reward' OR "source_customer_id" IS NOT NULL
  );
  ALTER TABLE "invitation_relationships" ADD CONSTRAINT "invitation_relationships_inviter_customer_id_customers_id_fk" FOREIGN KEY ("inviter_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_relationships" ADD CONSTRAINT "invitation_relationships_invitee_customer_id_customers_id_fk" FOREIGN KEY ("invitee_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_claims" ADD CONSTRAINT "invitation_reward_claims_relationship_id_invitation_relationships_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."invitation_relationships"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_claims" ADD CONSTRAINT "invitation_reward_claims_inviter_customer_id_customers_id_fk" FOREIGN KEY ("inviter_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_claims" ADD CONSTRAINT "invitation_reward_claims_invitee_customer_id_customers_id_fk" FOREIGN KEY ("invitee_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_claims" ADD CONSTRAINT "invitation_reward_claims_source_order_id_orders_id_fk" FOREIGN KEY ("source_order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_claims" ADD CONSTRAINT "invitation_reward_claims_rule_version_id_invitation_reward_rule_versions_id_fk" FOREIGN KEY ("rule_version_id") REFERENCES "public"."invitation_reward_rule_versions"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_events_signals" ADD CONSTRAINT "invitation_reward_events_signals_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."invitation_reward_events"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "invitation_reward_events" ADD CONSTRAINT "invitation_reward_events_claim_id_invitation_reward_claims_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."invitation_reward_claims"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_events" ADD CONSTRAINT "invitation_reward_events_inviter_customer_id_customers_id_fk" FOREIGN KEY ("inviter_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_events" ADD CONSTRAINT "invitation_reward_events_invitee_customer_id_customers_id_fk" FOREIGN KEY ("invitee_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "invitation_reward_events" ADD CONSTRAINT "invitation_reward_events_points_batch_id_points_batches_id_fk" FOREIGN KEY ("points_batch_id") REFERENCES "public"."points_batches"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "invitation_reward_rule_versions_effective_at_idx" ON "invitation_reward_rule_versions" USING btree ("effective_at");
  CREATE INDEX "invitation_reward_rule_versions_updated_at_idx" ON "invitation_reward_rule_versions" USING btree ("updated_at");
  CREATE INDEX "invitation_reward_rule_versions_created_at_idx" ON "invitation_reward_rule_versions" USING btree ("created_at");
  CREATE UNIQUE INDEX "version_idx" ON "invitation_reward_rule_versions" USING btree ("version");
  CREATE UNIQUE INDEX "invitation_relationships_relationship_key_idx" ON "invitation_relationships" USING btree ("relationship_key");
  CREATE INDEX "invitation_relationships_inviter_customer_idx" ON "invitation_relationships" USING btree ("inviter_customer_id");
  CREATE INDEX "invitation_relationships_invitee_customer_idx" ON "invitation_relationships" USING btree ("invitee_customer_id");
  CREATE INDEX "invitation_relationships_invite_code_hash_idx" ON "invitation_relationships" USING btree ("invite_code_hash");
  CREATE INDEX "invitation_relationships_binding_device_hash_idx" ON "invitation_relationships" USING btree ("binding_device_hash");
  CREATE INDEX "invitation_relationships_bound_at_idx" ON "invitation_relationships" USING btree ("bound_at");
  CREATE INDEX "invitation_relationships_updated_at_idx" ON "invitation_relationships" USING btree ("updated_at");
  CREATE INDEX "invitation_relationships_created_at_idx" ON "invitation_relationships" USING btree ("created_at");
  CREATE INDEX "inviterCustomer_boundAt_idx" ON "invitation_relationships" USING btree ("inviter_customer_id","bound_at");
  CREATE UNIQUE INDEX "inviteeCustomer_idx" ON "invitation_relationships" USING btree ("invitee_customer_id");
  CREATE UNIQUE INDEX "invitation_reward_claims_claim_key_idx" ON "invitation_reward_claims" USING btree ("claim_key");
  CREATE UNIQUE INDEX "invitation_reward_claims_relationship_idx" ON "invitation_reward_claims" USING btree ("relationship_id");
  CREATE INDEX "invitation_reward_claims_inviter_customer_idx" ON "invitation_reward_claims" USING btree ("inviter_customer_id");
  CREATE INDEX "invitation_reward_claims_invitee_customer_idx" ON "invitation_reward_claims" USING btree ("invitee_customer_id");
  CREATE INDEX "invitation_reward_claims_source_order_idx" ON "invitation_reward_claims" USING btree ("source_order_id");
  CREATE INDEX "invitation_reward_claims_rule_version_idx" ON "invitation_reward_claims" USING btree ("rule_version_id");
  CREATE INDEX "invitation_reward_claims_updated_at_idx" ON "invitation_reward_claims" USING btree ("updated_at");
  CREATE INDEX "invitation_reward_claims_created_at_idx" ON "invitation_reward_claims" USING btree ("created_at");
  CREATE UNIQUE INDEX "inviteeCustomer_1_idx" ON "invitation_reward_claims" USING btree ("invitee_customer_id");
  CREATE UNIQUE INDEX "sourceOrder_idx" ON "invitation_reward_claims" USING btree ("source_order_id");
  CREATE INDEX "invitation_reward_events_signals_order_idx" ON "invitation_reward_events_signals" USING btree ("order");
  CREATE INDEX "invitation_reward_events_signals_parent_idx" ON "invitation_reward_events_signals" USING btree ("parent_id");
  CREATE UNIQUE INDEX "invitation_reward_events_event_key_idx" ON "invitation_reward_events" USING btree ("event_key");
  CREATE INDEX "invitation_reward_events_claim_idx" ON "invitation_reward_events" USING btree ("claim_id");
  CREATE INDEX "invitation_reward_events_inviter_customer_idx" ON "invitation_reward_events" USING btree ("inviter_customer_id");
  CREATE INDEX "invitation_reward_events_invitee_customer_idx" ON "invitation_reward_events" USING btree ("invitee_customer_id");
  CREATE INDEX "invitation_reward_events_points_batch_idx" ON "invitation_reward_events" USING btree ("points_batch_id");
  CREATE INDEX "invitation_reward_events_occurred_at_idx" ON "invitation_reward_events" USING btree ("occurred_at");
  CREATE INDEX "invitation_reward_events_updated_at_idx" ON "invitation_reward_events" USING btree ("updated_at");
  CREATE INDEX "invitation_reward_events_created_at_idx" ON "invitation_reward_events" USING btree ("created_at");
  CREATE UNIQUE INDEX "claim_eventType_idx" ON "invitation_reward_events" USING btree ("claim_id","event_type");
  CREATE UNIQUE INDEX "invitation_reward_events_signals_parent_order_idx" ON "invitation_reward_events_signals" USING btree ("parent_id", "order");
  CREATE UNIQUE INDEX "invitation_reward_events_signals_parent_value_idx" ON "invitation_reward_events_signals" USING btree ("parent_id", "value");
  ALTER TABLE "points_batches" ADD CONSTRAINT "points_batches_source_customer_id_customers_id_fk" FOREIGN KEY ("source_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_invitation_reward_claim_id_invitation_reward_claims_id_fk" FOREIGN KEY ("invitation_reward_claim_id") REFERENCES "public"."invitation_reward_claims"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "customers_invite_code_disabled_at_idx" ON "customers" USING btree ("invite_code_disabled_at");
  CREATE INDEX "payment_notifications_payer_identifier_hash_idx" ON "payment_notifications" USING btree ("payer_identifier_hash");
  CREATE INDEX "payment_notification_archives_payer_identifier_hash_idx" ON "payment_notification_archives" USING btree ("payer_identifier_hash");
  CREATE INDEX "wallet_top_up_orders_payer_identifier_hash_idx" ON "wallet_top_up_orders" USING btree ("payer_identifier_hash");
  CREATE INDEX "points_batches_source_customer_idx" ON "points_batches" USING btree ("source_customer_id");
  CREATE UNIQUE INDEX "manual_reviews_invitation_reward_claim_idx" ON "manual_reviews" USING btree ("invitation_reward_claim_id");`)

  await db.execute(sql`
    ALTER TABLE "invitation_reward_rule_versions" ADD CONSTRAINT "invitation_reward_rule_versions_values_valid" CHECK (
      "version" = trunc("version") AND "version" BETWEEN 1 AND 9007199254740991 AND
      "schema_version" = 1 AND
      "reward_points" = trunc("reward_points") AND "reward_points" BETWEEN 1 AND 9007199254740991 AND
      "reward_expiry_days" = trunc("reward_expiry_days") AND "reward_expiry_days" BETWEEN 1 AND 3650 AND
      "binding_window_hours" = trunc("binding_window_hours") AND "binding_window_hours" BETWEEN 1 AND 720 AND
      length(trim("changed_by")) > 0 AND length(trim("change_note")) > 0
    );
    ALTER TABLE "invitation_relationships" ADD CONSTRAINT "invitation_relationships_values_valid" CHECK (
      "inviter_customer_id" <> "invitee_customer_id" AND
      "binding_window_ends_at" >= "bound_at"
    );
    ALTER TABLE "invitation_reward_claims" ADD CONSTRAINT "invitation_reward_claims_values_valid" CHECK (
      "inviter_customer_id" <> "invitee_customer_id" AND
      "rule_version_number" = trunc("rule_version_number") AND "rule_version_number" BETWEEN 1 AND 9007199254740991 AND
      "points" = trunc("points") AND "points" BETWEEN 1 AND 9007199254740991 AND
      "expires_at" > "created_at"
    );
    ALTER TABLE "invitation_reward_events" ADD CONSTRAINT "invitation_reward_events_values_valid" CHECK (
      "inviter_customer_id" <> "invitee_customer_id" AND
      (("event_type" IN ('pending', 'available') AND "points_batch_id" IS NOT NULL) OR
       ("event_type" IN ('withheld', 'flagged_after_release') AND "points_batch_id" IS NULL))
    );
    ALTER TABLE "payment_notifications" ADD CONSTRAINT "payment_notifications_payer_identifier_hash_valid" CHECK (
      "payer_identifier_hash" IS NULL OR "payer_identifier_hash" ~ '^[a-f0-9]{64}$'
    );
    ALTER TABLE "payment_notification_archives" ADD CONSTRAINT "payment_notification_archives_payer_identifier_hash_valid" CHECK (
      "payer_identifier_hash" IS NULL OR "payer_identifier_hash" ~ '^[a-f0-9]{64}$'
    );
    ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_payer_identifier_hash_valid" CHECK (
      "payer_identifier_hash" IS NULL OR "payer_identifier_hash" ~ '^[a-f0-9]{64}$'
    );

    INSERT INTO "invitation_relationships" (
      "relationship_key", "inviter_customer_id", "invitee_customer_id", "bind_source",
      "bound_at", "binding_window_ends_at", "updated_at", "created_at"
    )
    SELECT
      'invitee:' || invitee.id,
      invitee.invited_by_customer_id,
      invitee.id,
      'legacy_backfill',
      invitee.created_at,
      invitee.created_at,
      NOW(),
      invitee.created_at
    FROM "customers" AS invitee
    WHERE invitee.invited_by_customer_id IS NOT NULL
      AND invitee.invited_by_customer_id <> invitee.id
    ON CONFLICT (invitee_customer_id) DO NOTHING;
  `)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DO $$
   BEGIN
     IF EXISTS (SELECT 1 FROM "points_batches" WHERE "source_type" = 'invitation_reward') THEN
       RAISE EXCEPTION 'cannot roll back D9-E-1 while invitation reward points batches exist';
     END IF;
     IF EXISTS (SELECT 1 FROM "notification_outbox_events" WHERE "notification_type" = 'invitation_reward_withheld') THEN
       RAISE EXCEPTION 'cannot roll back D9-E-1 while invitation reward notifications exist';
     END IF;
  END $$;
  ALTER TABLE "notification_outbox_events" DROP CONSTRAINT "notification_outbox_events_category_type_valid";
  ALTER TABLE "points_batches" DROP CONSTRAINT "points_batches_source_customer_id_customers_id_fk";
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_invitation_reward_claim_id_invitation_reward_claims_id_fk";
  ALTER TABLE "invitation_reward_rule_versions" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "invitation_relationships" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "invitation_reward_claims" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "invitation_reward_events_signals" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "invitation_reward_events" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "invitation_reward_rule_versions" CASCADE;
  DROP TABLE "invitation_relationships" CASCADE;
  DROP TABLE "invitation_reward_claims" CASCADE;
  DROP TABLE "invitation_reward_events_signals" CASCADE;
  DROP TABLE "invitation_reward_events" CASCADE;
  ALTER TABLE "points_batches" DROP CONSTRAINT "points_batches_invitation_source_customer_required";
  ALTER TABLE "points_batches" ALTER COLUMN "source_type" SET DATA TYPE text;
  DROP TYPE "public"."enum_points_batches_source_type";
  CREATE TYPE "public"."enum_points_batches_source_type" AS ENUM('order_reward');
  ALTER TABLE "points_batches" ALTER COLUMN "source_type" SET DATA TYPE "public"."enum_points_batches_source_type" USING "source_type"::"public"."enum_points_batches_source_type";
  ALTER TABLE "notification_outbox_events" ALTER COLUMN "notification_type" SET DATA TYPE text;
  DROP TYPE "public"."enum_notification_outbox_events_notification_type";
  CREATE TYPE "public"."enum_notification_outbox_events_notification_type" AS ENUM('admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed', 'product_updates', 'promotions');
  ALTER TABLE "notification_outbox_events" ALTER COLUMN "notification_type" SET DATA TYPE "public"."enum_notification_outbox_events_notification_type" USING "notification_type"::"public"."enum_notification_outbox_events_notification_type";
  ALTER TABLE "notification_outbox_events" ADD CONSTRAINT "notification_outbox_events_category_type_valid" CHECK (
    ("category" = 'transactional' AND "notification_type" IN (
      'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed'
    )) OR
    ("category" = 'marketing' AND "notification_type" IN ('product_updates', 'promotions'))
  );
  DROP INDEX "customers_invite_code_disabled_at_idx";
  DROP INDEX "payment_notifications_payer_identifier_hash_idx";
  DROP INDEX "payment_notification_archives_payer_identifier_hash_idx";
  DROP INDEX "wallet_top_up_orders_payer_identifier_hash_idx";
  DROP INDEX "points_batches_source_customer_idx";
  DROP INDEX "manual_reviews_invitation_reward_claim_idx";
  ALTER TABLE "customers" DROP COLUMN "invite_code_disabled_at";
  ALTER TABLE "payment_notifications" DROP COLUMN "payer_identifier_hash";
  ALTER TABLE "payment_notification_archives" DROP COLUMN "payer_identifier_hash";
  ALTER TABLE "wallet_top_up_orders" DROP COLUMN "payer_identifier_hash";
  ALTER TABLE "points_batches" DROP COLUMN "source_customer_id";
  ALTER TABLE "manual_reviews" DROP COLUMN "invitation_reward_claim_id";
  DROP TYPE "public"."enum_invitation_relationships_bind_source";
  DROP TYPE "public"."enum_invitation_reward_events_signals";
  DROP TYPE "public"."enum_invitation_reward_events_event_type";`)
}
