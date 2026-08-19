import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_admins_operational_scopes" AS ENUM('funds_operations', 'system_configuration');
  CREATE TYPE "public"."enum_admin_approval_requests_operation_type" AS ENUM('large_balance_adjustment', 'original_refund', 'account_recovery', 'identity_conflict_resolution', 'vip_fraud_correction', 'high_risk_account_unfreeze', 'domain_management_credential_disposition', 'bulk_customer_asset_operation');
  CREATE TYPE "public"."enum_admin_approval_requests_status" AS ENUM('pending_approval', 'approved', 'executing', 'executed', 'rejected', 'failed');
  CREATE TYPE "public"."enum_admin_access_events_event_type" AS ENUM('requested', 'approved', 'rejected', 'execution_claimed', 'executed', 'failed');
  CREATE TYPE "public"."enum_notification_outbox_events_category" AS ENUM('transactional', 'marketing');
  CREATE TYPE "public"."enum_notification_outbox_events_notification_type" AS ENUM('admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed', 'product_updates', 'promotions');
  CREATE TYPE "public"."enum_notification_deliveries_channel" AS ENUM('sms', 'wechat', 'in_app');
  CREATE TYPE "public"."enum_notification_deliveries_status" AS ENUM('pending', 'sending', 'sent', 'delivered', 'retry_pending', 'dead_letter');
  CREATE TYPE "public"."enum_notification_provider_receipts_channel" AS ENUM('sms', 'wechat', 'in_app');
  CREATE TYPE "public"."enum_notification_provider_receipts_outcome" AS ENUM('accepted', 'delivered', 'failed', 'unknown');
  CREATE TYPE "public"."enum_notification_marketing_preferences_enabled_marketing_types" AS ENUM('product_updates', 'promotions');
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'notificationDelivery' BEFORE 'commerceFulfillment';
  CREATE TABLE "admins_operational_scopes" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_admins_operational_scopes",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "admin_approval_requests" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"request_key" varchar NOT NULL,
  	"operation_type" "enum_admin_approval_requests_operation_type" NOT NULL,
  	"status" "enum_admin_approval_requests_status" DEFAULT 'pending_approval' NOT NULL,
  	"customer_id" integer NOT NULL,
  	"target_type" varchar NOT NULL,
  	"target_id" varchar NOT NULL,
  	"amount_fen" numeric,
  	"operation_data" jsonb NOT NULL,
  	"reason_note" varchar NOT NULL,
  	"requested_by_id" integer NOT NULL,
  	"approved_by_id" integer,
  	"executed_by_id" integer,
	"requires_different_approver" boolean DEFAULT true NOT NULL,
  	"cooldown_seconds" numeric NOT NULL,
  	"approved_at" timestamp(3) with time zone,
  	"execution_claim_key" varchar,
  	"execution_claimed_at" timestamp(3) with time zone,
  	"executed_at" timestamp(3) with time zone,
  	"failed_at" timestamp(3) with time zone,
  	"failure_code" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "admin_access_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"event_type" "enum_admin_access_events_event_type" NOT NULL,
  	"approval_request_id" integer NOT NULL,
  	"actor_id" integer NOT NULL,
  	"metadata" jsonb,
  	"trace_id" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "notification_outbox_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"event_key" varchar NOT NULL,
  	"domain_event_type" varchar NOT NULL,
  	"category" "enum_notification_outbox_events_category" NOT NULL,
  	"notification_type" "enum_notification_outbox_events_notification_type" NOT NULL,
  	"customer_id" integer NOT NULL,
  	"template_key" varchar NOT NULL,
  	"template_version" numeric NOT NULL,
  	"subject_snapshot" varchar NOT NULL,
  	"body_snapshot" varchar NOT NULL,
  	"message_hash" varchar NOT NULL,
  	"trace_id" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "notification_deliveries" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"delivery_key" varchar NOT NULL,
  	"outbox_event_id" integer NOT NULL,
  	"customer_id" integer NOT NULL,
  	"channel" "enum_notification_deliveries_channel" NOT NULL,
  	"recipient_encrypted" varchar,
  	"recipient_masked" varchar NOT NULL,
  	"recipient_identity_hash" varchar NOT NULL,
  	"status" "enum_notification_deliveries_status" DEFAULT 'pending' NOT NULL,
  	"attempt_count" numeric DEFAULT 0 NOT NULL,
  	"max_attempts" numeric NOT NULL,
  	"next_attempt_at" timestamp(3) with time zone NOT NULL,
  	"claimed_at" timestamp(3) with time zone,
  	"provider_request_id" varchar,
  	"provider_message_id" varchar,
  	"provider_code" varchar,
  	"delivered_at" timestamp(3) with time zone,
  	"dead_lettered_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "notification_provider_receipts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"receipt_key" varchar NOT NULL,
  	"delivery_id" integer NOT NULL,
  	"channel" "enum_notification_provider_receipts_channel" NOT NULL,
  	"attempt_number" numeric NOT NULL,
  	"outcome" "enum_notification_provider_receipts_outcome" NOT NULL,
  	"provider_request_id" varchar,
  	"provider_message_id" varchar,
  	"provider_code" varchar,
  	"observed_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "notification_read_states" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"read_key" varchar NOT NULL,
  	"outbox_event_id" integer NOT NULL,
  	"customer_id" integer NOT NULL,
  	"read_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "notification_marketing_preferences_enabled_marketing_types" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_notification_marketing_preferences_enabled_marketing_types",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "notification_marketing_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );

  ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_values_valid" CHECK (
	"cooldown_seconds" = trunc("cooldown_seconds") AND
	"cooldown_seconds" BETWEEN 1 AND 604800 AND
	(
	  ("operation_type" = 'large_balance_adjustment' AND "amount_fen" = trunc("amount_fen") AND
	    "amount_fen" BETWEEN 1 AND 9007199254740991) OR
	  ("operation_type" <> 'large_balance_adjustment' AND "amount_fen" IS NULL)
	) AND
	(NOT "requires_different_approver" OR "approved_by_id" IS NULL OR "approved_by_id" <> "requested_by_id")
  );
  ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_state_evidence_valid" CHECK (
	(
	  "status" = 'pending_approval' AND "approved_by_id" IS NULL AND "approved_at" IS NULL AND
	  "executed_by_id" IS NULL AND "execution_claim_key" IS NULL AND "execution_claimed_at" IS NULL AND
	  "executed_at" IS NULL AND "failed_at" IS NULL AND "failure_code" IS NULL
	) OR (
	  "status" = 'approved' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND
	  "executed_by_id" IS NULL AND "execution_claim_key" IS NULL AND "execution_claimed_at" IS NULL AND
	  "executed_at" IS NULL AND "failed_at" IS NULL AND "failure_code" IS NULL
	) OR (
	  "status" = 'executing' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND
	  "executed_by_id" IS NOT NULL AND "execution_claim_key" IS NOT NULL AND "execution_claimed_at" IS NOT NULL AND
	  "executed_at" IS NULL AND "failed_at" IS NULL AND "failure_code" IS NULL
	) OR (
	  "status" = 'executed' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND
	  "executed_by_id" IS NOT NULL AND "execution_claim_key" IS NOT NULL AND "execution_claimed_at" IS NOT NULL AND
	  "executed_at" IS NOT NULL AND "failed_at" IS NULL AND "failure_code" IS NULL
	) OR (
	  "status" = 'rejected' AND "approved_by_id" IS NULL AND "approved_at" IS NULL AND
	  "executed_by_id" IS NULL AND "execution_claim_key" IS NULL AND "execution_claimed_at" IS NULL AND
	  "executed_at" IS NULL AND "failed_at" IS NULL AND "failure_code" IS NULL
	) OR (
	  "status" = 'failed' AND "approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND
	  "executed_by_id" IS NOT NULL AND "execution_claim_key" IS NOT NULL AND "execution_claimed_at" IS NOT NULL AND
	  "executed_at" IS NULL AND "failed_at" IS NOT NULL AND length(trim("failure_code")) > 0
	)
  );
  ALTER TABLE "notification_outbox_events" ADD CONSTRAINT "notification_outbox_events_category_type_valid" CHECK (
	("category" = 'transactional' AND "notification_type" IN (
	  'admin_high_risk_operation_submitted', 'admin_high_risk_operation_executed'
	)) OR
	("category" = 'marketing' AND "notification_type" IN ('product_updates', 'promotions'))
  );
  ALTER TABLE "notification_outbox_events" ADD CONSTRAINT "notification_outbox_events_snapshot_valid" CHECK (
	"template_version" = trunc("template_version") AND "template_version" BETWEEN 1 AND 9007199254740991 AND
	length(trim("subject_snapshot")) > 0 AND length(trim("body_snapshot")) > 0 AND
	length("message_hash") = 64
  );
  ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_values_valid" CHECK (
	"attempt_count" = trunc("attempt_count") AND "attempt_count" BETWEEN 0 AND 9007199254740991 AND
	"max_attempts" = trunc("max_attempts") AND "max_attempts" BETWEEN 1 AND 100 AND
	"attempt_count" <= "max_attempts" AND
	(("channel" = 'in_app' AND "recipient_encrypted" IS NULL) OR
	 ("channel" IN ('sms', 'wechat') AND "recipient_encrypted" IS NOT NULL)) AND
	(
	  ("status" = 'pending' AND "attempt_count" = 0 AND "claimed_at" IS NULL AND
	    "provider_request_id" IS NULL AND "provider_message_id" IS NULL AND
	    "delivered_at" IS NULL AND "dead_lettered_at" IS NULL) OR
	  ("status" = 'sending' AND "attempt_count" >= 1 AND "claimed_at" IS NOT NULL AND
	    "delivered_at" IS NULL AND "dead_lettered_at" IS NULL) OR
	  ("status" = 'sent' AND "attempt_count" >= 1 AND "claimed_at" IS NOT NULL AND
	    "provider_message_id" IS NOT NULL AND "delivered_at" IS NULL AND "dead_lettered_at" IS NULL) OR
	  ("status" = 'retry_pending' AND "attempt_count" >= 1 AND "claimed_at" IS NOT NULL AND
	    "delivered_at" IS NULL AND "dead_lettered_at" IS NULL) OR
	  ("status" = 'delivered' AND "attempt_count" >= 1 AND "claimed_at" IS NOT NULL AND
	    "delivered_at" IS NOT NULL AND "dead_lettered_at" IS NULL) OR
	  ("status" = 'dead_letter' AND "attempt_count" >= 1 AND "claimed_at" IS NOT NULL AND
	    "delivered_at" IS NULL AND "dead_lettered_at" IS NOT NULL)
	)
  );
  ALTER TABLE "notification_provider_receipts" ADD CONSTRAINT "notification_provider_receipts_attempt_valid" CHECK (
	"attempt_number" = trunc("attempt_number") AND "attempt_number" BETWEEN 1 AND 9007199254740991
  );
  
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "admin_approval_requests_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "admin_access_events_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notification_outbox_events_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notification_deliveries_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notification_provider_receipts_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notification_read_states_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "notification_marketing_preferences_id" integer;
  ALTER TABLE "admins_operational_scopes" ADD CONSTRAINT "admins_operational_scopes_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_requested_by_id_admins_id_fk" FOREIGN KEY ("requested_by_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_approved_by_id_admins_id_fk" FOREIGN KEY ("approved_by_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "admin_approval_requests" ADD CONSTRAINT "admin_approval_requests_executed_by_id_admins_id_fk" FOREIGN KEY ("executed_by_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "admin_access_events" ADD CONSTRAINT "admin_access_events_approval_request_id_admin_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "admin_access_events" ADD CONSTRAINT "admin_access_events_actor_id_admins_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notification_outbox_events" ADD CONSTRAINT "notification_outbox_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_outbox_event_id_notification_outbox_events_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."notification_outbox_events"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notification_provider_receipts" ADD CONSTRAINT "notification_provider_receipts_delivery_id_notification_deliveries_id_fk" FOREIGN KEY ("delivery_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notification_read_states" ADD CONSTRAINT "notification_read_states_outbox_event_id_notification_outbox_events_id_fk" FOREIGN KEY ("outbox_event_id") REFERENCES "public"."notification_outbox_events"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notification_read_states" ADD CONSTRAINT "notification_read_states_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "notification_marketing_preferences_enabled_marketing_types" ADD CONSTRAINT "notification_marketing_preferences_enabled_marketing_types_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."notification_marketing_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "notification_marketing_preferences" ADD CONSTRAINT "notification_marketing_preferences_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "admins_operational_scopes_order_idx" ON "admins_operational_scopes" USING btree ("order");
  CREATE INDEX "admins_operational_scopes_parent_idx" ON "admins_operational_scopes" USING btree ("parent_id");
  CREATE UNIQUE INDEX "admin_approval_requests_request_key_idx" ON "admin_approval_requests" USING btree ("request_key");
  CREATE INDEX "admin_approval_requests_customer_idx" ON "admin_approval_requests" USING btree ("customer_id");
  CREATE INDEX "admin_approval_requests_target_type_idx" ON "admin_approval_requests" USING btree ("target_type");
  CREATE INDEX "admin_approval_requests_target_id_idx" ON "admin_approval_requests" USING btree ("target_id");
  CREATE INDEX "admin_approval_requests_requested_by_idx" ON "admin_approval_requests" USING btree ("requested_by_id");
  CREATE INDEX "admin_approval_requests_approved_by_idx" ON "admin_approval_requests" USING btree ("approved_by_id");
  CREATE INDEX "admin_approval_requests_executed_by_idx" ON "admin_approval_requests" USING btree ("executed_by_id");
  CREATE INDEX "admin_approval_requests_approved_at_idx" ON "admin_approval_requests" USING btree ("approved_at");
  CREATE UNIQUE INDEX "admin_approval_requests_execution_claim_key_idx" ON "admin_approval_requests" USING btree ("execution_claim_key");
  CREATE INDEX "admin_approval_requests_execution_claimed_at_idx" ON "admin_approval_requests" USING btree ("execution_claimed_at");
  CREATE INDEX "admin_approval_requests_executed_at_idx" ON "admin_approval_requests" USING btree ("executed_at");
  CREATE INDEX "admin_approval_requests_failed_at_idx" ON "admin_approval_requests" USING btree ("failed_at");
  CREATE INDEX "admin_approval_requests_updated_at_idx" ON "admin_approval_requests" USING btree ("updated_at");
  CREATE INDEX "admin_approval_requests_created_at_idx" ON "admin_approval_requests" USING btree ("created_at");
  CREATE INDEX "status_createdAt_idx" ON "admin_approval_requests" USING btree ("status","created_at");
  CREATE INDEX "customer_operationType_createdAt_idx" ON "admin_approval_requests" USING btree ("customer_id","operation_type","created_at");
  CREATE INDEX "operationType_targetId_status_idx" ON "admin_approval_requests" USING btree ("operation_type","target_id","status");
  CREATE UNIQUE INDEX "admin_access_events_event_key_idx" ON "admin_access_events" USING btree ("event_key");
  CREATE INDEX "admin_access_events_approval_request_idx" ON "admin_access_events" USING btree ("approval_request_id");
  CREATE INDEX "admin_access_events_actor_idx" ON "admin_access_events" USING btree ("actor_id");
  CREATE INDEX "admin_access_events_trace_id_idx" ON "admin_access_events" USING btree ("trace_id");
  CREATE INDEX "admin_access_events_updated_at_idx" ON "admin_access_events" USING btree ("updated_at");
  CREATE INDEX "admin_access_events_created_at_idx" ON "admin_access_events" USING btree ("created_at");
  CREATE INDEX "approvalRequest_createdAt_idx" ON "admin_access_events" USING btree ("approval_request_id","created_at");
  CREATE INDEX "actor_createdAt_idx" ON "admin_access_events" USING btree ("actor_id","created_at");
  CREATE UNIQUE INDEX "notification_outbox_events_event_key_idx" ON "notification_outbox_events" USING btree ("event_key");
  CREATE INDEX "notification_outbox_events_domain_event_type_idx" ON "notification_outbox_events" USING btree ("domain_event_type");
  CREATE INDEX "notification_outbox_events_customer_idx" ON "notification_outbox_events" USING btree ("customer_id");
  CREATE INDEX "notification_outbox_events_message_hash_idx" ON "notification_outbox_events" USING btree ("message_hash");
  CREATE INDEX "notification_outbox_events_trace_id_idx" ON "notification_outbox_events" USING btree ("trace_id");
  CREATE INDEX "notification_outbox_events_updated_at_idx" ON "notification_outbox_events" USING btree ("updated_at");
  CREATE INDEX "notification_outbox_events_created_at_idx" ON "notification_outbox_events" USING btree ("created_at");
  CREATE INDEX "customer_notificationType_createdAt_idx" ON "notification_outbox_events" USING btree ("customer_id","notification_type","created_at");
  CREATE INDEX "category_notificationType_createdAt_idx" ON "notification_outbox_events" USING btree ("category","notification_type","created_at");
  CREATE UNIQUE INDEX "notification_deliveries_delivery_key_idx" ON "notification_deliveries" USING btree ("delivery_key");
  CREATE INDEX "notification_deliveries_outbox_event_idx" ON "notification_deliveries" USING btree ("outbox_event_id");
  CREATE INDEX "notification_deliveries_customer_idx" ON "notification_deliveries" USING btree ("customer_id");
  CREATE INDEX "notification_deliveries_recipient_identity_hash_idx" ON "notification_deliveries" USING btree ("recipient_identity_hash");
  CREATE INDEX "notification_deliveries_next_attempt_at_idx" ON "notification_deliveries" USING btree ("next_attempt_at");
  CREATE INDEX "notification_deliveries_claimed_at_idx" ON "notification_deliveries" USING btree ("claimed_at");
  CREATE INDEX "notification_deliveries_delivered_at_idx" ON "notification_deliveries" USING btree ("delivered_at");
  CREATE INDEX "notification_deliveries_dead_lettered_at_idx" ON "notification_deliveries" USING btree ("dead_lettered_at");
  CREATE INDEX "notification_deliveries_updated_at_idx" ON "notification_deliveries" USING btree ("updated_at");
  CREATE INDEX "notification_deliveries_created_at_idx" ON "notification_deliveries" USING btree ("created_at");
  CREATE INDEX "status_nextAttemptAt_idx" ON "notification_deliveries" USING btree ("status","next_attempt_at");
  CREATE INDEX "outboxEvent_channel_idx" ON "notification_deliveries" USING btree ("outbox_event_id","channel");
  CREATE UNIQUE INDEX "notification_provider_receipts_receipt_key_idx" ON "notification_provider_receipts" USING btree ("receipt_key");
  CREATE INDEX "notification_provider_receipts_delivery_idx" ON "notification_provider_receipts" USING btree ("delivery_id");
  CREATE INDEX "notification_provider_receipts_observed_at_idx" ON "notification_provider_receipts" USING btree ("observed_at");
  CREATE INDEX "notification_provider_receipts_updated_at_idx" ON "notification_provider_receipts" USING btree ("updated_at");
  CREATE INDEX "notification_provider_receipts_created_at_idx" ON "notification_provider_receipts" USING btree ("created_at");
  CREATE UNIQUE INDEX "notification_read_states_read_key_idx" ON "notification_read_states" USING btree ("read_key");
  CREATE INDEX "notification_read_states_outbox_event_idx" ON "notification_read_states" USING btree ("outbox_event_id");
  CREATE INDEX "notification_read_states_customer_idx" ON "notification_read_states" USING btree ("customer_id");
  CREATE INDEX "notification_read_states_read_at_idx" ON "notification_read_states" USING btree ("read_at");
  CREATE INDEX "notification_read_states_updated_at_idx" ON "notification_read_states" USING btree ("updated_at");
  CREATE INDEX "notification_read_states_created_at_idx" ON "notification_read_states" USING btree ("created_at");
  CREATE INDEX "customer_readAt_idx" ON "notification_read_states" USING btree ("customer_id","read_at");
  CREATE UNIQUE INDEX "notification_read_states_event_customer_idx" ON "notification_read_states" USING btree ("outbox_event_id","customer_id");
  CREATE INDEX "notification_marketing_preferences_enabled_marketing_types_order_idx" ON "notification_marketing_preferences_enabled_marketing_types" USING btree ("order");
  CREATE INDEX "notification_marketing_preferences_enabled_marketing_types_parent_idx" ON "notification_marketing_preferences_enabled_marketing_types" USING btree ("parent_id");
  CREATE UNIQUE INDEX "notification_marketing_preferences_customer_idx" ON "notification_marketing_preferences" USING btree ("customer_id");
  CREATE INDEX "notification_marketing_preferences_updated_at_idx" ON "notification_marketing_preferences" USING btree ("updated_at");
  CREATE INDEX "notification_marketing_preferences_created_at_idx" ON "notification_marketing_preferences" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_admin_approval_requests_fk" FOREIGN KEY ("admin_approval_requests_id") REFERENCES "public"."admin_approval_requests"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_admin_access_events_fk" FOREIGN KEY ("admin_access_events_id") REFERENCES "public"."admin_access_events"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notification_outbox_events_fk" FOREIGN KEY ("notification_outbox_events_id") REFERENCES "public"."notification_outbox_events"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notification_deliveries_fk" FOREIGN KEY ("notification_deliveries_id") REFERENCES "public"."notification_deliveries"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notification_provider_recei_fk" FOREIGN KEY ("notification_provider_receipts_id") REFERENCES "public"."notification_provider_receipts"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notification_read_states_fk" FOREIGN KEY ("notification_read_states_id") REFERENCES "public"."notification_read_states"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_notification_marketing_pref_fk" FOREIGN KEY ("notification_marketing_preferences_id") REFERENCES "public"."notification_marketing_preferences"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_admin_approval_requests_id_idx" ON "payload_locked_documents_rels" USING btree ("admin_approval_requests_id");
  CREATE INDEX "payload_locked_documents_rels_admin_access_events_id_idx" ON "payload_locked_documents_rels" USING btree ("admin_access_events_id");
  CREATE INDEX "payload_locked_documents_rels_notification_outbox_events_idx" ON "payload_locked_documents_rels" USING btree ("notification_outbox_events_id");
  CREATE INDEX "payload_locked_documents_rels_notification_deliveries_id_idx" ON "payload_locked_documents_rels" USING btree ("notification_deliveries_id");
  CREATE INDEX "payload_locked_documents_rels_notification_provider_rece_idx" ON "payload_locked_documents_rels" USING btree ("notification_provider_receipts_id");
  CREATE INDEX "payload_locked_documents_rels_notification_read_states_i_idx" ON "payload_locked_documents_rels" USING btree ("notification_read_states_id");
  CREATE INDEX "payload_locked_documents_rels_notification_marketing_pre_idx" ON "payload_locked_documents_rels" USING btree ("notification_marketing_preferences_id");

  INSERT INTO "admins_operational_scopes" ("order", "parent_id", "value")
  SELECT scope_values."order", system_admins."parent_id", scope_values."value"::"enum_admins_operational_scopes"
  FROM (
	SELECT DISTINCT "parent_id" FROM "admins_roles" WHERE "value" = 'system_admin'
  ) AS system_admins
  CROSS JOIN (VALUES (1, 'funds_operations'), (2, 'system_configuration')) AS scope_values("order", "value")
  ON CONFLICT DO NOTHING;

  INSERT INTO "site_settings" ("key", "value", "description")
  VALUES (
	'admin.high-risk-approval-policy',
	jsonb_build_object(
	  'schemaVersion', 1,
	  'requiresDifferentApprover', true,
	  'cooldownSeconds', 900,
	  'updatedAt', to_char(CURRENT_TIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
	  'updatedBy', 'system:migration'
	),
	'后台高风险操作双人审批、单人冷静延迟与告警配置'
  );`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM "admin_approval_requests") OR
       EXISTS (SELECT 1 FROM "admin_access_events") OR
       EXISTS (SELECT 1 FROM "notification_outbox_events") OR
       EXISTS (SELECT 1 FROM "notification_deliveries") OR
       EXISTS (SELECT 1 FROM "notification_provider_receipts") OR
       EXISTS (SELECT 1 FROM "notification_read_states") OR
       EXISTS (SELECT 1 FROM "notification_marketing_preferences") OR
       NOT EXISTS (
	 SELECT 1 FROM "site_settings"
	 WHERE "key" = 'admin.high-risk-approval-policy'
       ) OR
       EXISTS (
	 SELECT 1 FROM "site_settings"
	 WHERE "key" = 'admin.high-risk-approval-policy' AND (
	   "value"->>'schemaVersion' <> '1' OR
	   "value"->>'requiresDifferentApprover' <> 'true' OR
	   "value"->>'cooldownSeconds' <> '900' OR
	   "value"->>'updatedBy' <> 'system:migration'
	 )
       ) OR
       EXISTS (
	 SELECT 1 FROM "admins_operational_scopes" scopes
	 WHERE NOT EXISTS (
	   SELECT 1 FROM "admins_roles" roles
	   WHERE roles."parent_id" = scopes."parent_id" AND roles."value" = 'system_admin'
	 )
       ) OR
       EXISTS (
	 SELECT 1
	 FROM (SELECT DISTINCT "parent_id" FROM "admins_roles" WHERE "value" = 'system_admin') system_admins
	 WHERE (
	   SELECT COUNT(DISTINCT scopes."value")
	   FROM "admins_operational_scopes" scopes
	   WHERE scopes."parent_id" = system_admins."parent_id" AND
	     scopes."value" IN ('funds_operations', 'system_configuration')
	 ) <> 2
       ) THEN
      RAISE EXCEPTION 'D9-B-5 down migration refused: approval, notification, scope, or changed policy data exists';
    END IF;
  END $$;
  DELETE FROM "site_settings" WHERE "key" = 'admin.high-risk-approval-policy';
  `)
  await db.execute(sql`
   ALTER TABLE "admins_operational_scopes" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "admin_approval_requests" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "admin_access_events" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "notification_outbox_events" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "notification_deliveries" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "notification_provider_receipts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "notification_read_states" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "notification_marketing_preferences_enabled_marketing_types" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "notification_marketing_preferences" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "admins_operational_scopes" CASCADE;
  DROP TABLE "admin_approval_requests" CASCADE;
  DROP TABLE "admin_access_events" CASCADE;
  DROP TABLE "notification_outbox_events" CASCADE;
  DROP TABLE "notification_deliveries" CASCADE;
  DROP TABLE "notification_provider_receipts" CASCADE;
  DROP TABLE "notification_read_states" CASCADE;
  DROP TABLE "notification_marketing_preferences_enabled_marketing_types" CASCADE;
  DROP TABLE "notification_marketing_preferences" CASCADE;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_admin_approval_requests_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_admin_access_events_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_notification_outbox_events_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_notification_deliveries_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_notification_provider_recei_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_notification_read_states_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT IF EXISTS "payload_locked_documents_rels_notification_marketing_pref_fk";
  
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'contentScheduledPublish', 'backgroundProbe', 'advertisingMaintenance', 'smsReceiptReconciliation', 'realnameCleanup', 'westdigitalBalanceMonitoring', 'domainExpiryReminders', 'domainAssetSynchronization', 'walletLedgerConsistencyCheck', 'commerceFulfillment', 'automaticRenewalScheduling', 'commerceWorkerHeartbeat', 'nameserverChange', 'wechatRefund', 'paymentTimeoutClose');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "payload_locked_documents_rels_admin_approval_requests_id_idx";
  DROP INDEX "payload_locked_documents_rels_admin_access_events_id_idx";
  DROP INDEX "payload_locked_documents_rels_notification_outbox_events_idx";
  DROP INDEX "payload_locked_documents_rels_notification_deliveries_id_idx";
  DROP INDEX "payload_locked_documents_rels_notification_provider_rece_idx";
  DROP INDEX "payload_locked_documents_rels_notification_read_states_i_idx";
  DROP INDEX "payload_locked_documents_rels_notification_marketing_pre_idx";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "admin_approval_requests_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "admin_access_events_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notification_outbox_events_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notification_deliveries_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notification_provider_receipts_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notification_read_states_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "notification_marketing_preferences_id";
  DROP TYPE "public"."enum_admins_operational_scopes";
  DROP TYPE "public"."enum_admin_approval_requests_operation_type";
  DROP TYPE "public"."enum_admin_approval_requests_status";
  DROP TYPE "public"."enum_admin_access_events_event_type";
  DROP TYPE "public"."enum_notification_outbox_events_category";
  DROP TYPE "public"."enum_notification_outbox_events_notification_type";
  DROP TYPE "public"."enum_notification_deliveries_channel";
  DROP TYPE "public"."enum_notification_deliveries_status";
  DROP TYPE "public"."enum_notification_provider_receipts_channel";
  DROP TYPE "public"."enum_notification_provider_receipts_outcome";
  DROP TYPE "public"."enum_notification_marketing_preferences_enabled_marketing_types";`)
}
