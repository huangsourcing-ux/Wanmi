import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_admins_roles" AS ENUM('content_editor', 'ad_operator', 'analyst', 'system_admin');
  CREATE TYPE "public"."enum_customers_status" AS ENUM('active', 'disabled', 'deletion_requested');
  CREATE TYPE "public"."enum_articles_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__articles_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_topics_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__topics_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_tld_pages_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__tld_pages_v_version_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum_advertisers_status" AS ENUM('active', 'paused');
  CREATE TYPE "public"."enum_ad_creatives_status" AS ENUM('draft', 'approved', 'disabled');
  CREATE TYPE "public"."enum_ad_schedules_status" AS ENUM('scheduled', 'active', 'ended', 'disabled');
  CREATE TYPE "public"."enum_realname_templates_type" AS ENUM('individual', 'organization');
  CREATE TYPE "public"."enum_realname_templates_status" AS ENUM('draft', 'pending_review', 'verified', 'rejected', 'manual_review', 'disabled');
  CREATE TYPE "public"."enum_price_rules_mode" AS ENUM('fixed', 'percentage');
  CREATE TYPE "public"."enum_quotes_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_orders_status" AS ENUM('pending_payment', 'paid', 'fulfilling', 'succeeded', 'refund_pending', 'refunding', 'refunded', 'manual_review', 'cancelled');
  CREATE TYPE "public"."enum_orders_currency" AS ENUM('CNY');
  CREATE TYPE "public"."enum_order_events_from_status" AS ENUM('pending_payment', 'paid', 'fulfilling', 'succeeded', 'refund_pending', 'refunding', 'refunded', 'manual_review', 'cancelled');
  CREATE TYPE "public"."enum_order_events_to_status" AS ENUM('pending_payment', 'paid', 'fulfilling', 'succeeded', 'refund_pending', 'refunding', 'refunded', 'manual_review', 'cancelled');
  CREATE TYPE "public"."enum_order_events_actor_type" AS ENUM('system', 'customer', 'admin', 'provider');
  CREATE TYPE "public"."enum_refunds_status" AS ENUM('pending', 'submitted', 'succeeded', 'failed', 'unknown');
  CREATE TYPE "public"."enum_provider_operations_provider" AS ENUM('westdigital', 'wechatpay');
  CREATE TYPE "public"."enum_provider_operations_operation" AS ENUM('register', 'renew', 'refund', 'nameserver', 'query');
  CREATE TYPE "public"."enum_provider_operations_status" AS ENUM('prepared', 'submitted', 'succeeded', 'failed', 'unknown');
  CREATE TYPE "public"."enum_domain_assets_status" AS ENUM('active', 'expired', 'pending', 'unknown');
  CREATE TYPE "public"."enum_renewals_status" AS ENUM('pending', 'succeeded', 'failed', 'manual_review');
  CREATE TYPE "public"."enum_nameserver_changes_status" AS ENUM('pending', 'succeeded', 'failed', 'manual_review');
  CREATE TYPE "public"."enum_manual_reviews_status" AS ENUM('open', 'resolved');
  CREATE TYPE "public"."enum_reconciliations_kind" AS ENUM('wechat', 'westdigital', 'three_way');
  CREATE TYPE "public"."enum_reconciliations_status" AS ENUM('pending', 'matched', 'difference', 'reviewed');
  CREATE TYPE "public"."enum_audit_logs_actor_type" AS ENUM('anonymous', 'customer', 'admin', 'system', 'provider');
  CREATE TYPE "public"."enum_user_feedback_category" AS ENUM('contact', 'feedback', 'request');
  CREATE TYPE "public"."enum_user_feedback_status" AS ENUM('new', 'reviewed', 'closed');
  CREATE TYPE "public"."enum_redirects_to_type" AS ENUM('reference', 'custom');
  CREATE TYPE "public"."enum_redirects_type" AS ENUM('301', '302');
  CREATE TYPE "public"."enum_forms_confirmation_type" AS ENUM('message', 'redirect');
  CREATE TYPE "public"."enum_forms_redirect_type" AS ENUM('reference', 'custom');
  CREATE TYPE "public"."enum_forms_purpose" AS ENUM('contact', 'feedback', 'request');
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline', 'schedulePublish');
  CREATE TYPE "public"."enum_payload_jobs_log_state" AS ENUM('failed', 'succeeded');
  CREATE TYPE "public"."enum_payload_jobs_log_parent_task_slug" AS ENUM('inline', 'schedulePublish');
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'backgroundProbe', 'commerceFulfillment');
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline', 'schedulePublish');
  CREATE TABLE "admins_roles" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_admins_roles",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "admins_sessions" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"created_at" timestamp(3) with time zone,
  	"expires_at" timestamp(3) with time zone NOT NULL
  );
  
  CREATE TABLE "admins" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"totp_secret_encrypted" varchar,
  	"totp_enabled" boolean DEFAULT false NOT NULL,
  	"totp_last_used_step" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"email" varchar NOT NULL,
  	"reset_password_token" varchar,
  	"reset_password_expiration" timestamp(3) with time zone,
  	"salt" varchar,
  	"hash" varchar,
  	"login_attempts" numeric DEFAULT 0,
  	"lock_until" timestamp(3) with time zone
  );
  
  CREATE TABLE "admins_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "customers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"phone" varchar NOT NULL,
  	"phone_masked" varchar NOT NULL,
  	"status" "enum_customers_status" DEFAULT 'active' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "sms_challenges" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"challenge_id" varchar NOT NULL,
  	"phone" varchar NOT NULL,
  	"phone_hash" varchar NOT NULL,
  	"code_hash" varchar NOT NULL,
  	"ip_hash" varchar NOT NULL,
  	"device_hash" varchar NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"attempts" numeric DEFAULT 0 NOT NULL,
  	"consumed_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "customer_sessions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"token_hash" varchar NOT NULL,
  	"device_hash" varchar NOT NULL,
  	"ip_hash" varchar NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"revoked_at" timestamp(3) with time zone,
  	"last_seen_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "articles" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"slug" varchar,
  	"summary" varchar,
  	"content" jsonb,
  	"published_at" timestamp(3) with time zone,
  	"source" varchar,
  	"meta_title" varchar,
  	"meta_description" varchar,
  	"meta_image_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_articles_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_articles_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_title" varchar,
  	"version_slug" varchar,
  	"version_summary" varchar,
  	"version_content" jsonb,
  	"version_published_at" timestamp(3) with time zone,
  	"version_source" varchar,
  	"version_meta_title" varchar,
  	"version_meta_description" varchar,
  	"version_meta_image_id" integer,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__articles_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean,
  	"autosave" boolean
  );
  
  CREATE TABLE "topics" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"slug" varchar,
  	"summary" varchar,
  	"content" jsonb,
  	"published_at" timestamp(3) with time zone,
  	"source" varchar,
  	"meta_title" varchar,
  	"meta_description" varchar,
  	"meta_image_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_topics_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_topics_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_title" varchar,
  	"version_slug" varchar,
  	"version_summary" varchar,
  	"version_content" jsonb,
  	"version_published_at" timestamp(3) with time zone,
  	"version_source" varchar,
  	"version_meta_title" varchar,
  	"version_meta_description" varchar,
  	"version_meta_image_id" integer,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__topics_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean,
  	"autosave" boolean
  );
  
  CREATE TABLE "tld_pages" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"slug" varchar,
  	"summary" varchar,
  	"content" jsonb,
  	"published_at" timestamp(3) with time zone,
  	"source" varchar,
  	"meta_title" varchar,
  	"meta_description" varchar,
  	"meta_image_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_tld_pages_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_tld_pages_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_title" varchar,
  	"version_slug" varchar,
  	"version_summary" varchar,
  	"version_content" jsonb,
  	"version_published_at" timestamp(3) with time zone,
  	"version_source" varchar,
  	"version_meta_title" varchar,
  	"version_meta_description" varchar,
  	"version_meta_image_id" integer,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__tld_pages_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean,
  	"autosave" boolean
  );
  
  CREATE TABLE "media" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"alt" varchar NOT NULL,
  	"source" varchar,
  	"reviewed" boolean DEFAULT false NOT NULL,
  	"prefix" varchar DEFAULT '',
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"url" varchar,
  	"thumbnail_u_r_l" varchar,
  	"filename" varchar,
  	"mime_type" varchar,
  	"filesize" numeric,
  	"width" numeric,
  	"height" numeric,
  	"focal_x" numeric,
  	"focal_y" numeric
  );
  
  CREATE TABLE "navigation" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"label" varchar NOT NULL,
  	"href" varchar NOT NULL,
  	"order" numeric NOT NULL,
  	"enabled" boolean DEFAULT true NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "site_settings" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"value" jsonb NOT NULL,
  	"description" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "advertisers" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"status" "enum_advertisers_status" DEFAULT 'active' NOT NULL,
  	"notes" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "ad_creatives" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"advertiser_id" integer NOT NULL,
  	"image_id" integer NOT NULL,
  	"alt" varchar NOT NULL,
  	"target_url" varchar NOT NULL,
  	"status" "enum_ad_creatives_status" DEFAULT 'draft' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "ad_placements" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"code" varchar NOT NULL,
  	"description" varchar NOT NULL,
  	"enabled" boolean DEFAULT true NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "ad_schedules" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"creative_id" integer NOT NULL,
  	"placement_id" integer NOT NULL,
  	"starts_at" timestamp(3) with time zone NOT NULL,
  	"ends_at" timestamp(3) with time zone NOT NULL,
  	"status" "enum_ad_schedules_status" DEFAULT 'scheduled' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "realname_templates" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"display_name" varchar NOT NULL,
  	"type" "enum_realname_templates_type" NOT NULL,
  	"status" "enum_realname_templates_status" DEFAULT 'draft' NOT NULL,
  	"provider_template_id" varchar,
  	"safe_failure_reason" varchar,
  	"disabled_at" timestamp(3) with time zone,
  	"cleanup_due_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "realname_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"template_id" integer NOT NULL,
  	"object_key" varchar NOT NULL,
  	"encrypted_data_key" varchar NOT NULL,
  	"content_type" varchar NOT NULL,
  	"size_bytes" numeric NOT NULL,
  	"sha256" varchar NOT NULL,
  	"deleted_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "price_rules" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"tld" varchar NOT NULL,
  	"mode" "enum_price_rules_mode" NOT NULL,
  	"fixed_amount_minor" numeric NOT NULL,
  	"percentage_basis_points" numeric,
  	"enabled" boolean DEFAULT false NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "quotes" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"domain_ascii" varchar NOT NULL,
  	"years" numeric NOT NULL,
  	"upstream_cost_minor" numeric NOT NULL,
  	"user_price_minor" numeric NOT NULL,
  	"currency" "enum_quotes_currency" DEFAULT 'CNY' NOT NULL,
  	"rule_snapshot" jsonb NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "orders" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order_number" varchar NOT NULL,
  	"customer_id" integer NOT NULL,
  	"quote_id" integer NOT NULL,
  	"realname_template_id" integer NOT NULL,
  	"domain_ascii" varchar NOT NULL,
  	"status" "enum_orders_status" DEFAULT 'pending_payment' NOT NULL,
  	"amount_minor" numeric NOT NULL,
  	"currency" "enum_orders_currency" DEFAULT 'CNY' NOT NULL,
  	"quote_snapshot" jsonb NOT NULL,
  	"paid_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "order_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order_id" integer NOT NULL,
  	"customer_id" integer NOT NULL,
  	"from_status" "enum_order_events_from_status",
  	"to_status" "enum_order_events_to_status" NOT NULL,
  	"reason_code" varchar NOT NULL,
  	"note" varchar,
  	"evidence" jsonb,
  	"actor_type" "enum_order_events_actor_type" NOT NULL,
  	"actor_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payment_notifications" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"wechat_transaction_id" varchar NOT NULL,
  	"merchant_order_number" varchar NOT NULL,
  	"signature_verified" boolean DEFAULT false NOT NULL,
  	"amount_minor" numeric NOT NULL,
  	"received_at" timestamp(3) with time zone NOT NULL,
  	"payload_digest" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "refunds" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"refund_number" varchar NOT NULL,
  	"order_id" integer NOT NULL,
  	"amount_minor" numeric NOT NULL,
  	"status" "enum_refunds_status" NOT NULL,
  	"provider_refund_id" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "provider_operations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"operation_key" varchar NOT NULL,
  	"order_id" integer NOT NULL,
  	"provider" "enum_provider_operations_provider" NOT NULL,
  	"operation" "enum_provider_operations_operation" NOT NULL,
  	"status" "enum_provider_operations_status" NOT NULL,
  	"provider_request_id" varchar,
  	"submitted_at" timestamp(3) with time zone,
  	"last_checked_at" timestamp(3) with time zone,
  	"safe_result" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "domain_assets" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"realname_template_id" integer NOT NULL,
  	"domain_ascii" varchar NOT NULL,
  	"registrar" varchar NOT NULL,
  	"registered_at" timestamp(3) with time zone NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"status" "enum_domain_assets_status" NOT NULL,
  	"last_synced_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "domain_assets_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "renewals" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"order_id" integer NOT NULL,
  	"years" numeric NOT NULL,
  	"status" "enum_renewals_status" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "nameserver_changes" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"asset_id" integer NOT NULL,
  	"status" "enum_nameserver_changes_status" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "nameserver_changes_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "manual_reviews" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order_id" integer,
  	"reason_code" varchar NOT NULL,
  	"status" "enum_manual_reviews_status" DEFAULT 'open' NOT NULL,
  	"evidence" jsonb,
  	"resolution_note" varchar,
  	"resolved_by_id" integer,
  	"resolved_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "reconciliations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"kind" "enum_reconciliations_kind" NOT NULL,
  	"period_start" timestamp(3) with time zone NOT NULL,
  	"period_end" timestamp(3) with time zone NOT NULL,
  	"status" "enum_reconciliations_status" NOT NULL,
  	"summary" jsonb NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "audit_logs" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"action" varchar NOT NULL,
  	"actor_type" "enum_audit_logs_actor_type" NOT NULL,
  	"actor_id" varchar,
  	"target_type" varchar NOT NULL,
  	"target_id" varchar,
  	"trace_id" varchar NOT NULL,
  	"metadata" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "user_feedback" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer,
  	"category" "enum_user_feedback_category" NOT NULL,
  	"message" varchar NOT NULL,
  	"status" "enum_user_feedback_status" DEFAULT 'new' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "customer_security_events" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"event" varchar NOT NULL,
  	"occurred_at" timestamp(3) with time zone NOT NULL,
  	"safe_metadata" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "redirects" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"from" varchar NOT NULL,
  	"to_type" "enum_redirects_to_type" DEFAULT 'reference',
  	"to_url" varchar,
  	"type" "enum_redirects_type" NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "redirects_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"articles_id" integer,
  	"topics_id" integer,
  	"tld_pages_id" integer
  );
  
  CREATE TABLE "forms_blocks_checkbox" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"required" boolean,
  	"default_value" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_email" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_message" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"message" jsonb,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_number" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" numeric,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_select_options" (
  	"_order" integer NOT NULL,
  	"_parent_id" varchar NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"label" varchar NOT NULL,
  	"value" varchar NOT NULL
  );
  
  CREATE TABLE "forms_blocks_select" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"placeholder" varchar,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_text" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_blocks_textarea" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"_path" text NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"name" varchar NOT NULL,
  	"label" varchar,
  	"width" numeric,
  	"default_value" varchar,
  	"required" boolean,
  	"block_name" varchar
  );
  
  CREATE TABLE "forms_emails" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"email_to" varchar,
  	"cc" varchar,
  	"bcc" varchar,
  	"reply_to" varchar,
  	"email_from" varchar,
  	"subject" varchar DEFAULT 'You''ve received a new message.' NOT NULL,
  	"message" jsonb
  );
  
  CREATE TABLE "forms" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"submit_button_label" varchar,
  	"confirmation_type" "enum_forms_confirmation_type" DEFAULT 'message',
  	"confirmation_message" jsonb,
  	"redirect_type" "enum_forms_redirect_type" DEFAULT 'reference',
  	"redirect_url" varchar,
  	"purpose" "enum_forms_purpose" DEFAULT 'feedback' NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "forms_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"articles_id" integer,
  	"topics_id" integer,
  	"tld_pages_id" integer
  );
  
  CREATE TABLE "form_submissions_submission_data" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"field" varchar NOT NULL,
  	"value" varchar NOT NULL
  );
  
  CREATE TABLE "form_submissions" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"form_id" integer NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_kv" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar NOT NULL,
  	"data" jsonb NOT NULL
  );
  
  CREATE TABLE "payload_jobs_log" (
  	"_order" integer NOT NULL,
  	"_parent_id" integer NOT NULL,
  	"id" varchar PRIMARY KEY NOT NULL,
  	"executed_at" timestamp(3) with time zone NOT NULL,
  	"completed_at" timestamp(3) with time zone NOT NULL,
  	"task_slug" "enum_payload_jobs_log_task_slug" NOT NULL,
  	"task_i_d" varchar NOT NULL,
  	"input" jsonb,
  	"output" jsonb,
  	"state" "enum_payload_jobs_log_state" NOT NULL,
  	"error" jsonb,
  	"parent_task_slug" "enum_payload_jobs_log_parent_task_slug",
  	"parent_task_i_d" varchar
  );
  
  CREATE TABLE "payload_jobs" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"input" jsonb,
  	"completed_at" timestamp(3) with time zone,
  	"total_tried" numeric DEFAULT 0,
  	"has_error" boolean DEFAULT false,
  	"error" jsonb,
  	"workflow_slug" "enum_payload_jobs_workflow_slug",
  	"task_slug" "enum_payload_jobs_task_slug",
  	"queue" varchar DEFAULT 'default',
  	"wait_until" timestamp(3) with time zone,
  	"processing" boolean DEFAULT false,
  	"concurrency_key" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"global_slug" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_locked_documents_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"admins_id" integer,
  	"customers_id" integer,
  	"sms_challenges_id" integer,
  	"customer_sessions_id" integer,
  	"articles_id" integer,
  	"topics_id" integer,
  	"tld_pages_id" integer,
  	"media_id" integer,
  	"navigation_id" integer,
  	"site_settings_id" integer,
  	"advertisers_id" integer,
  	"ad_creatives_id" integer,
  	"ad_placements_id" integer,
  	"ad_schedules_id" integer,
  	"realname_templates_id" integer,
  	"realname_documents_id" integer,
  	"price_rules_id" integer,
  	"quotes_id" integer,
  	"orders_id" integer,
  	"order_events_id" integer,
  	"payment_notifications_id" integer,
  	"refunds_id" integer,
  	"provider_operations_id" integer,
  	"domain_assets_id" integer,
  	"renewals_id" integer,
  	"nameserver_changes_id" integer,
  	"manual_reviews_id" integer,
  	"reconciliations_id" integer,
  	"audit_logs_id" integer,
  	"user_feedback_id" integer,
  	"customer_security_events_id" integer,
  	"redirects_id" integer,
  	"forms_id" integer,
  	"form_submissions_id" integer
  );
  
  CREATE TABLE "payload_preferences" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"key" varchar,
  	"value" jsonb,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "payload_preferences_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"admins_id" integer,
  	"customers_id" integer
  );
  
  CREATE TABLE "payload_migrations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"name" varchar,
  	"batch" numeric,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "admins_roles" ADD CONSTRAINT "admins_roles_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "admins_sessions" ADD CONSTRAINT "admins_sessions_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "admins_texts" ADD CONSTRAINT "admins_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "articles" ADD CONSTRAINT "articles_meta_image_id_media_id_fk" FOREIGN KEY ("meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_parent_id_articles_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."articles"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_articles_v" ADD CONSTRAINT "_articles_v_version_meta_image_id_media_id_fk" FOREIGN KEY ("version_meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "topics" ADD CONSTRAINT "topics_meta_image_id_media_id_fk" FOREIGN KEY ("meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_topics_v" ADD CONSTRAINT "_topics_v_parent_id_topics_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_topics_v" ADD CONSTRAINT "_topics_v_version_meta_image_id_media_id_fk" FOREIGN KEY ("version_meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tld_pages" ADD CONSTRAINT "tld_pages_meta_image_id_media_id_fk" FOREIGN KEY ("meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_tld_pages_v" ADD CONSTRAINT "_tld_pages_v_parent_id_tld_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tld_pages"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_tld_pages_v" ADD CONSTRAINT "_tld_pages_v_version_meta_image_id_media_id_fk" FOREIGN KEY ("version_meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_advertiser_id_advertisers_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."advertisers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_schedules" ADD CONSTRAINT "ad_schedules_creative_id_ad_creatives_id_fk" FOREIGN KEY ("creative_id") REFERENCES "public"."ad_creatives"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "ad_schedules" ADD CONSTRAINT "ad_schedules_placement_id_ad_placements_id_fk" FOREIGN KEY ("placement_id") REFERENCES "public"."ad_placements"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "realname_templates" ADD CONSTRAINT "realname_templates_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "realname_documents" ADD CONSTRAINT "realname_documents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "realname_documents" ADD CONSTRAINT "realname_documents_template_id_realname_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."realname_templates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_quote_id_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."quotes"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "orders" ADD CONSTRAINT "orders_realname_template_id_realname_templates_id_fk" FOREIGN KEY ("realname_template_id") REFERENCES "public"."realname_templates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "order_events" ADD CONSTRAINT "order_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "order_events" ADD CONSTRAINT "order_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "refunds" ADD CONSTRAINT "refunds_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "provider_operations" ADD CONSTRAINT "provider_operations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_assets" ADD CONSTRAINT "domain_assets_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_assets" ADD CONSTRAINT "domain_assets_realname_template_id_realname_templates_id_fk" FOREIGN KEY ("realname_template_id") REFERENCES "public"."realname_templates"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "domain_assets_texts" ADD CONSTRAINT "domain_assets_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."domain_assets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "renewals" ADD CONSTRAINT "renewals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "renewals" ADD CONSTRAINT "renewals_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "renewals" ADD CONSTRAINT "renewals_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "nameserver_changes" ADD CONSTRAINT "nameserver_changes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "nameserver_changes" ADD CONSTRAINT "nameserver_changes_asset_id_domain_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."domain_assets"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "nameserver_changes_texts" ADD CONSTRAINT "nameserver_changes_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."nameserver_changes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_resolved_by_id_admins_id_fk" FOREIGN KEY ("resolved_by_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "user_feedback" ADD CONSTRAINT "user_feedback_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "customer_security_events" ADD CONSTRAINT "customer_security_events_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "redirects_rels" ADD CONSTRAINT "redirects_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."redirects"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "redirects_rels" ADD CONSTRAINT "redirects_rels_articles_fk" FOREIGN KEY ("articles_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "redirects_rels" ADD CONSTRAINT "redirects_rels_topics_fk" FOREIGN KEY ("topics_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "redirects_rels" ADD CONSTRAINT "redirects_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_checkbox" ADD CONSTRAINT "forms_blocks_checkbox_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_email" ADD CONSTRAINT "forms_blocks_email_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_message" ADD CONSTRAINT "forms_blocks_message_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_number" ADD CONSTRAINT "forms_blocks_number_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_select_options" ADD CONSTRAINT "forms_blocks_select_options_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms_blocks_select"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_select" ADD CONSTRAINT "forms_blocks_select_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_text" ADD CONSTRAINT "forms_blocks_text_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_blocks_textarea" ADD CONSTRAINT "forms_blocks_textarea_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_emails" ADD CONSTRAINT "forms_emails_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_rels" ADD CONSTRAINT "forms_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_rels" ADD CONSTRAINT "forms_rels_articles_fk" FOREIGN KEY ("articles_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_rels" ADD CONSTRAINT "forms_rels_topics_fk" FOREIGN KEY ("topics_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "forms_rels" ADD CONSTRAINT "forms_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "form_submissions_submission_data" ADD CONSTRAINT "form_submissions_submission_data_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."form_submissions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_jobs_log" ADD CONSTRAINT "payload_jobs_log_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."payload_jobs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_locked_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_admins_fk" FOREIGN KEY ("admins_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_customers_fk" FOREIGN KEY ("customers_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_sms_challenges_fk" FOREIGN KEY ("sms_challenges_id") REFERENCES "public"."sms_challenges"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_customer_sessions_fk" FOREIGN KEY ("customer_sessions_id") REFERENCES "public"."customer_sessions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_articles_fk" FOREIGN KEY ("articles_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_topics_fk" FOREIGN KEY ("topics_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_navigation_fk" FOREIGN KEY ("navigation_id") REFERENCES "public"."navigation"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_site_settings_fk" FOREIGN KEY ("site_settings_id") REFERENCES "public"."site_settings"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_advertisers_fk" FOREIGN KEY ("advertisers_id") REFERENCES "public"."advertisers"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ad_creatives_fk" FOREIGN KEY ("ad_creatives_id") REFERENCES "public"."ad_creatives"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ad_placements_fk" FOREIGN KEY ("ad_placements_id") REFERENCES "public"."ad_placements"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ad_schedules_fk" FOREIGN KEY ("ad_schedules_id") REFERENCES "public"."ad_schedules"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_realname_templates_fk" FOREIGN KEY ("realname_templates_id") REFERENCES "public"."realname_templates"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_realname_documents_fk" FOREIGN KEY ("realname_documents_id") REFERENCES "public"."realname_documents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_price_rules_fk" FOREIGN KEY ("price_rules_id") REFERENCES "public"."price_rules"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_quotes_fk" FOREIGN KEY ("quotes_id") REFERENCES "public"."quotes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_orders_fk" FOREIGN KEY ("orders_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_order_events_fk" FOREIGN KEY ("order_events_id") REFERENCES "public"."order_events"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_payment_notifications_fk" FOREIGN KEY ("payment_notifications_id") REFERENCES "public"."payment_notifications"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_refunds_fk" FOREIGN KEY ("refunds_id") REFERENCES "public"."refunds"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_provider_operations_fk" FOREIGN KEY ("provider_operations_id") REFERENCES "public"."provider_operations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_domain_assets_fk" FOREIGN KEY ("domain_assets_id") REFERENCES "public"."domain_assets"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_renewals_fk" FOREIGN KEY ("renewals_id") REFERENCES "public"."renewals"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_nameserver_changes_fk" FOREIGN KEY ("nameserver_changes_id") REFERENCES "public"."nameserver_changes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_manual_reviews_fk" FOREIGN KEY ("manual_reviews_id") REFERENCES "public"."manual_reviews"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_reconciliations_fk" FOREIGN KEY ("reconciliations_id") REFERENCES "public"."reconciliations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_audit_logs_fk" FOREIGN KEY ("audit_logs_id") REFERENCES "public"."audit_logs"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_user_feedback_fk" FOREIGN KEY ("user_feedback_id") REFERENCES "public"."user_feedback"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_customer_security_events_fk" FOREIGN KEY ("customer_security_events_id") REFERENCES "public"."customer_security_events"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_redirects_fk" FOREIGN KEY ("redirects_id") REFERENCES "public"."redirects"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_forms_fk" FOREIGN KEY ("forms_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_form_submissions_fk" FOREIGN KEY ("form_submissions_id") REFERENCES "public"."form_submissions"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."payload_preferences"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_admins_fk" FOREIGN KEY ("admins_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_preferences_rels" ADD CONSTRAINT "payload_preferences_rels_customers_fk" FOREIGN KEY ("customers_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "admins_roles_order_idx" ON "admins_roles" USING btree ("order");
  CREATE INDEX "admins_roles_parent_idx" ON "admins_roles" USING btree ("parent_id");
  CREATE INDEX "admins_sessions_order_idx" ON "admins_sessions" USING btree ("_order");
  CREATE INDEX "admins_sessions_parent_id_idx" ON "admins_sessions" USING btree ("_parent_id");
  CREATE INDEX "admins_updated_at_idx" ON "admins" USING btree ("updated_at");
  CREATE INDEX "admins_created_at_idx" ON "admins" USING btree ("created_at");
  CREATE UNIQUE INDEX "admins_email_idx" ON "admins" USING btree ("email");
  CREATE INDEX "admins_texts_order_parent" ON "admins_texts" USING btree ("order","parent_id");
  CREATE UNIQUE INDEX "customers_phone_idx" ON "customers" USING btree ("phone");
  CREATE INDEX "customers_updated_at_idx" ON "customers" USING btree ("updated_at");
  CREATE INDEX "customers_created_at_idx" ON "customers" USING btree ("created_at");
  CREATE UNIQUE INDEX "sms_challenges_challenge_id_idx" ON "sms_challenges" USING btree ("challenge_id");
  CREATE INDEX "sms_challenges_phone_hash_idx" ON "sms_challenges" USING btree ("phone_hash");
  CREATE INDEX "sms_challenges_ip_hash_idx" ON "sms_challenges" USING btree ("ip_hash");
  CREATE INDEX "sms_challenges_device_hash_idx" ON "sms_challenges" USING btree ("device_hash");
  CREATE INDEX "sms_challenges_expires_at_idx" ON "sms_challenges" USING btree ("expires_at");
  CREATE INDEX "sms_challenges_consumed_at_idx" ON "sms_challenges" USING btree ("consumed_at");
  CREATE INDEX "sms_challenges_updated_at_idx" ON "sms_challenges" USING btree ("updated_at");
  CREATE INDEX "sms_challenges_created_at_idx" ON "sms_challenges" USING btree ("created_at");
  CREATE INDEX "customer_sessions_customer_idx" ON "customer_sessions" USING btree ("customer_id");
  CREATE UNIQUE INDEX "customer_sessions_token_hash_idx" ON "customer_sessions" USING btree ("token_hash");
  CREATE INDEX "customer_sessions_device_hash_idx" ON "customer_sessions" USING btree ("device_hash");
  CREATE INDEX "customer_sessions_ip_hash_idx" ON "customer_sessions" USING btree ("ip_hash");
  CREATE INDEX "customer_sessions_expires_at_idx" ON "customer_sessions" USING btree ("expires_at");
  CREATE INDEX "customer_sessions_revoked_at_idx" ON "customer_sessions" USING btree ("revoked_at");
  CREATE INDEX "customer_sessions_updated_at_idx" ON "customer_sessions" USING btree ("updated_at");
  CREATE INDEX "customer_sessions_created_at_idx" ON "customer_sessions" USING btree ("created_at");
  CREATE UNIQUE INDEX "articles_slug_idx" ON "articles" USING btree ("slug");
  CREATE INDEX "articles_published_at_idx" ON "articles" USING btree ("published_at");
  CREATE INDEX "articles_meta_meta_image_idx" ON "articles" USING btree ("meta_image_id");
  CREATE INDEX "articles_updated_at_idx" ON "articles" USING btree ("updated_at");
  CREATE INDEX "articles_created_at_idx" ON "articles" USING btree ("created_at");
  CREATE INDEX "articles__status_idx" ON "articles" USING btree ("_status");
  CREATE INDEX "_articles_v_parent_idx" ON "_articles_v" USING btree ("parent_id");
  CREATE INDEX "_articles_v_version_version_slug_idx" ON "_articles_v" USING btree ("version_slug");
  CREATE INDEX "_articles_v_version_version_published_at_idx" ON "_articles_v" USING btree ("version_published_at");
  CREATE INDEX "_articles_v_version_meta_version_meta_image_idx" ON "_articles_v" USING btree ("version_meta_image_id");
  CREATE INDEX "_articles_v_version_version_updated_at_idx" ON "_articles_v" USING btree ("version_updated_at");
  CREATE INDEX "_articles_v_version_version_created_at_idx" ON "_articles_v" USING btree ("version_created_at");
  CREATE INDEX "_articles_v_version_version__status_idx" ON "_articles_v" USING btree ("version__status");
  CREATE INDEX "_articles_v_created_at_idx" ON "_articles_v" USING btree ("created_at");
  CREATE INDEX "_articles_v_updated_at_idx" ON "_articles_v" USING btree ("updated_at");
  CREATE INDEX "_articles_v_latest_idx" ON "_articles_v" USING btree ("latest");
  CREATE INDEX "_articles_v_autosave_idx" ON "_articles_v" USING btree ("autosave");
  CREATE UNIQUE INDEX "topics_slug_idx" ON "topics" USING btree ("slug");
  CREATE INDEX "topics_published_at_idx" ON "topics" USING btree ("published_at");
  CREATE INDEX "topics_meta_meta_image_idx" ON "topics" USING btree ("meta_image_id");
  CREATE INDEX "topics_updated_at_idx" ON "topics" USING btree ("updated_at");
  CREATE INDEX "topics_created_at_idx" ON "topics" USING btree ("created_at");
  CREATE INDEX "topics__status_idx" ON "topics" USING btree ("_status");
  CREATE INDEX "_topics_v_parent_idx" ON "_topics_v" USING btree ("parent_id");
  CREATE INDEX "_topics_v_version_version_slug_idx" ON "_topics_v" USING btree ("version_slug");
  CREATE INDEX "_topics_v_version_version_published_at_idx" ON "_topics_v" USING btree ("version_published_at");
  CREATE INDEX "_topics_v_version_meta_version_meta_image_idx" ON "_topics_v" USING btree ("version_meta_image_id");
  CREATE INDEX "_topics_v_version_version_updated_at_idx" ON "_topics_v" USING btree ("version_updated_at");
  CREATE INDEX "_topics_v_version_version_created_at_idx" ON "_topics_v" USING btree ("version_created_at");
  CREATE INDEX "_topics_v_version_version__status_idx" ON "_topics_v" USING btree ("version__status");
  CREATE INDEX "_topics_v_created_at_idx" ON "_topics_v" USING btree ("created_at");
  CREATE INDEX "_topics_v_updated_at_idx" ON "_topics_v" USING btree ("updated_at");
  CREATE INDEX "_topics_v_latest_idx" ON "_topics_v" USING btree ("latest");
  CREATE INDEX "_topics_v_autosave_idx" ON "_topics_v" USING btree ("autosave");
  CREATE UNIQUE INDEX "tld_pages_slug_idx" ON "tld_pages" USING btree ("slug");
  CREATE INDEX "tld_pages_published_at_idx" ON "tld_pages" USING btree ("published_at");
  CREATE INDEX "tld_pages_meta_meta_image_idx" ON "tld_pages" USING btree ("meta_image_id");
  CREATE INDEX "tld_pages_updated_at_idx" ON "tld_pages" USING btree ("updated_at");
  CREATE INDEX "tld_pages_created_at_idx" ON "tld_pages" USING btree ("created_at");
  CREATE INDEX "tld_pages__status_idx" ON "tld_pages" USING btree ("_status");
  CREATE INDEX "_tld_pages_v_parent_idx" ON "_tld_pages_v" USING btree ("parent_id");
  CREATE INDEX "_tld_pages_v_version_version_slug_idx" ON "_tld_pages_v" USING btree ("version_slug");
  CREATE INDEX "_tld_pages_v_version_version_published_at_idx" ON "_tld_pages_v" USING btree ("version_published_at");
  CREATE INDEX "_tld_pages_v_version_meta_version_meta_image_idx" ON "_tld_pages_v" USING btree ("version_meta_image_id");
  CREATE INDEX "_tld_pages_v_version_version_updated_at_idx" ON "_tld_pages_v" USING btree ("version_updated_at");
  CREATE INDEX "_tld_pages_v_version_version_created_at_idx" ON "_tld_pages_v" USING btree ("version_created_at");
  CREATE INDEX "_tld_pages_v_version_version__status_idx" ON "_tld_pages_v" USING btree ("version__status");
  CREATE INDEX "_tld_pages_v_created_at_idx" ON "_tld_pages_v" USING btree ("created_at");
  CREATE INDEX "_tld_pages_v_updated_at_idx" ON "_tld_pages_v" USING btree ("updated_at");
  CREATE INDEX "_tld_pages_v_latest_idx" ON "_tld_pages_v" USING btree ("latest");
  CREATE INDEX "_tld_pages_v_autosave_idx" ON "_tld_pages_v" USING btree ("autosave");
  CREATE INDEX "media_updated_at_idx" ON "media" USING btree ("updated_at");
  CREATE INDEX "media_created_at_idx" ON "media" USING btree ("created_at");
  CREATE UNIQUE INDEX "media_filename_idx" ON "media" USING btree ("filename");
  CREATE INDEX "navigation_updated_at_idx" ON "navigation" USING btree ("updated_at");
  CREATE INDEX "navigation_created_at_idx" ON "navigation" USING btree ("created_at");
  CREATE UNIQUE INDEX "site_settings_key_idx" ON "site_settings" USING btree ("key");
  CREATE INDEX "site_settings_updated_at_idx" ON "site_settings" USING btree ("updated_at");
  CREATE INDEX "site_settings_created_at_idx" ON "site_settings" USING btree ("created_at");
  CREATE INDEX "advertisers_updated_at_idx" ON "advertisers" USING btree ("updated_at");
  CREATE INDEX "advertisers_created_at_idx" ON "advertisers" USING btree ("created_at");
  CREATE INDEX "ad_creatives_advertiser_idx" ON "ad_creatives" USING btree ("advertiser_id");
  CREATE INDEX "ad_creatives_image_idx" ON "ad_creatives" USING btree ("image_id");
  CREATE INDEX "ad_creatives_updated_at_idx" ON "ad_creatives" USING btree ("updated_at");
  CREATE INDEX "ad_creatives_created_at_idx" ON "ad_creatives" USING btree ("created_at");
  CREATE UNIQUE INDEX "ad_placements_code_idx" ON "ad_placements" USING btree ("code");
  CREATE INDEX "ad_placements_updated_at_idx" ON "ad_placements" USING btree ("updated_at");
  CREATE INDEX "ad_placements_created_at_idx" ON "ad_placements" USING btree ("created_at");
  CREATE INDEX "ad_schedules_creative_idx" ON "ad_schedules" USING btree ("creative_id");
  CREATE INDEX "ad_schedules_placement_idx" ON "ad_schedules" USING btree ("placement_id");
  CREATE INDEX "ad_schedules_starts_at_idx" ON "ad_schedules" USING btree ("starts_at");
  CREATE INDEX "ad_schedules_ends_at_idx" ON "ad_schedules" USING btree ("ends_at");
  CREATE INDEX "ad_schedules_updated_at_idx" ON "ad_schedules" USING btree ("updated_at");
  CREATE INDEX "ad_schedules_created_at_idx" ON "ad_schedules" USING btree ("created_at");
  CREATE INDEX "realname_templates_customer_idx" ON "realname_templates" USING btree ("customer_id");
  CREATE INDEX "realname_templates_provider_template_id_idx" ON "realname_templates" USING btree ("provider_template_id");
  CREATE INDEX "realname_templates_cleanup_due_at_idx" ON "realname_templates" USING btree ("cleanup_due_at");
  CREATE INDEX "realname_templates_updated_at_idx" ON "realname_templates" USING btree ("updated_at");
  CREATE INDEX "realname_templates_created_at_idx" ON "realname_templates" USING btree ("created_at");
  CREATE INDEX "realname_documents_customer_idx" ON "realname_documents" USING btree ("customer_id");
  CREATE INDEX "realname_documents_template_idx" ON "realname_documents" USING btree ("template_id");
  CREATE UNIQUE INDEX "realname_documents_object_key_idx" ON "realname_documents" USING btree ("object_key");
  CREATE INDEX "realname_documents_deleted_at_idx" ON "realname_documents" USING btree ("deleted_at");
  CREATE INDEX "realname_documents_updated_at_idx" ON "realname_documents" USING btree ("updated_at");
  CREATE INDEX "realname_documents_created_at_idx" ON "realname_documents" USING btree ("created_at");
  CREATE UNIQUE INDEX "price_rules_tld_idx" ON "price_rules" USING btree ("tld");
  CREATE INDEX "price_rules_updated_at_idx" ON "price_rules" USING btree ("updated_at");
  CREATE INDEX "price_rules_created_at_idx" ON "price_rules" USING btree ("created_at");
  CREATE INDEX "quotes_customer_idx" ON "quotes" USING btree ("customer_id");
  CREATE INDEX "quotes_domain_ascii_idx" ON "quotes" USING btree ("domain_ascii");
  CREATE INDEX "quotes_expires_at_idx" ON "quotes" USING btree ("expires_at");
  CREATE INDEX "quotes_updated_at_idx" ON "quotes" USING btree ("updated_at");
  CREATE INDEX "quotes_created_at_idx" ON "quotes" USING btree ("created_at");
  CREATE UNIQUE INDEX "orders_order_number_idx" ON "orders" USING btree ("order_number");
  CREATE INDEX "orders_customer_idx" ON "orders" USING btree ("customer_id");
  CREATE INDEX "orders_quote_idx" ON "orders" USING btree ("quote_id");
  CREATE INDEX "orders_realname_template_idx" ON "orders" USING btree ("realname_template_id");
  CREATE INDEX "orders_domain_ascii_idx" ON "orders" USING btree ("domain_ascii");
  CREATE INDEX "orders_status_idx" ON "orders" USING btree ("status");
  CREATE INDEX "orders_updated_at_idx" ON "orders" USING btree ("updated_at");
  CREATE INDEX "orders_created_at_idx" ON "orders" USING btree ("created_at");
  CREATE INDEX "order_events_order_idx" ON "order_events" USING btree ("order_id");
  CREATE INDEX "order_events_customer_idx" ON "order_events" USING btree ("customer_id");
  CREATE INDEX "order_events_updated_at_idx" ON "order_events" USING btree ("updated_at");
  CREATE INDEX "order_events_created_at_idx" ON "order_events" USING btree ("created_at");
  CREATE UNIQUE INDEX "payment_notifications_wechat_transaction_id_idx" ON "payment_notifications" USING btree ("wechat_transaction_id");
  CREATE INDEX "payment_notifications_merchant_order_number_idx" ON "payment_notifications" USING btree ("merchant_order_number");
  CREATE INDEX "payment_notifications_updated_at_idx" ON "payment_notifications" USING btree ("updated_at");
  CREATE INDEX "payment_notifications_created_at_idx" ON "payment_notifications" USING btree ("created_at");
  CREATE UNIQUE INDEX "refunds_refund_number_idx" ON "refunds" USING btree ("refund_number");
  CREATE INDEX "refunds_order_idx" ON "refunds" USING btree ("order_id");
  CREATE UNIQUE INDEX "refunds_provider_refund_id_idx" ON "refunds" USING btree ("provider_refund_id");
  CREATE INDEX "refunds_updated_at_idx" ON "refunds" USING btree ("updated_at");
  CREATE INDEX "refunds_created_at_idx" ON "refunds" USING btree ("created_at");
  CREATE UNIQUE INDEX "provider_operations_operation_key_idx" ON "provider_operations" USING btree ("operation_key");
  CREATE INDEX "provider_operations_order_idx" ON "provider_operations" USING btree ("order_id");
  CREATE INDEX "provider_operations_provider_request_id_idx" ON "provider_operations" USING btree ("provider_request_id");
  CREATE INDEX "provider_operations_updated_at_idx" ON "provider_operations" USING btree ("updated_at");
  CREATE INDEX "provider_operations_created_at_idx" ON "provider_operations" USING btree ("created_at");
  CREATE INDEX "domain_assets_customer_idx" ON "domain_assets" USING btree ("customer_id");
  CREATE INDEX "domain_assets_realname_template_idx" ON "domain_assets" USING btree ("realname_template_id");
  CREATE UNIQUE INDEX "domain_assets_domain_ascii_idx" ON "domain_assets" USING btree ("domain_ascii");
  CREATE INDEX "domain_assets_expires_at_idx" ON "domain_assets" USING btree ("expires_at");
  CREATE INDEX "domain_assets_updated_at_idx" ON "domain_assets" USING btree ("updated_at");
  CREATE INDEX "domain_assets_created_at_idx" ON "domain_assets" USING btree ("created_at");
  CREATE INDEX "domain_assets_texts_order_parent" ON "domain_assets_texts" USING btree ("order","parent_id");
  CREATE INDEX "renewals_customer_idx" ON "renewals" USING btree ("customer_id");
  CREATE INDEX "renewals_asset_idx" ON "renewals" USING btree ("asset_id");
  CREATE INDEX "renewals_order_idx" ON "renewals" USING btree ("order_id");
  CREATE INDEX "renewals_updated_at_idx" ON "renewals" USING btree ("updated_at");
  CREATE INDEX "renewals_created_at_idx" ON "renewals" USING btree ("created_at");
  CREATE INDEX "nameserver_changes_customer_idx" ON "nameserver_changes" USING btree ("customer_id");
  CREATE INDEX "nameserver_changes_asset_idx" ON "nameserver_changes" USING btree ("asset_id");
  CREATE INDEX "nameserver_changes_updated_at_idx" ON "nameserver_changes" USING btree ("updated_at");
  CREATE INDEX "nameserver_changes_created_at_idx" ON "nameserver_changes" USING btree ("created_at");
  CREATE INDEX "nameserver_changes_texts_order_parent" ON "nameserver_changes_texts" USING btree ("order","parent_id");
  CREATE INDEX "manual_reviews_order_idx" ON "manual_reviews" USING btree ("order_id");
  CREATE INDEX "manual_reviews_reason_code_idx" ON "manual_reviews" USING btree ("reason_code");
  CREATE INDEX "manual_reviews_resolved_by_idx" ON "manual_reviews" USING btree ("resolved_by_id");
  CREATE INDEX "manual_reviews_updated_at_idx" ON "manual_reviews" USING btree ("updated_at");
  CREATE INDEX "manual_reviews_created_at_idx" ON "manual_reviews" USING btree ("created_at");
  CREATE INDEX "reconciliations_updated_at_idx" ON "reconciliations" USING btree ("updated_at");
  CREATE INDEX "reconciliations_created_at_idx" ON "reconciliations" USING btree ("created_at");
  CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action");
  CREATE INDEX "audit_logs_trace_id_idx" ON "audit_logs" USING btree ("trace_id");
  CREATE INDEX "audit_logs_updated_at_idx" ON "audit_logs" USING btree ("updated_at");
  CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs" USING btree ("created_at");
  CREATE INDEX "user_feedback_customer_idx" ON "user_feedback" USING btree ("customer_id");
  CREATE INDEX "user_feedback_updated_at_idx" ON "user_feedback" USING btree ("updated_at");
  CREATE INDEX "user_feedback_created_at_idx" ON "user_feedback" USING btree ("created_at");
  CREATE INDEX "customer_security_events_customer_idx" ON "customer_security_events" USING btree ("customer_id");
  CREATE INDEX "customer_security_events_updated_at_idx" ON "customer_security_events" USING btree ("updated_at");
  CREATE INDEX "customer_security_events_created_at_idx" ON "customer_security_events" USING btree ("created_at");
  CREATE UNIQUE INDEX "redirects_from_idx" ON "redirects" USING btree ("from");
  CREATE INDEX "redirects_updated_at_idx" ON "redirects" USING btree ("updated_at");
  CREATE INDEX "redirects_created_at_idx" ON "redirects" USING btree ("created_at");
  CREATE INDEX "redirects_rels_order_idx" ON "redirects_rels" USING btree ("order");
  CREATE INDEX "redirects_rels_parent_idx" ON "redirects_rels" USING btree ("parent_id");
  CREATE INDEX "redirects_rels_path_idx" ON "redirects_rels" USING btree ("path");
  CREATE INDEX "redirects_rels_articles_id_idx" ON "redirects_rels" USING btree ("articles_id");
  CREATE INDEX "redirects_rels_topics_id_idx" ON "redirects_rels" USING btree ("topics_id");
  CREATE INDEX "redirects_rels_tld_pages_id_idx" ON "redirects_rels" USING btree ("tld_pages_id");
  CREATE INDEX "forms_blocks_checkbox_order_idx" ON "forms_blocks_checkbox" USING btree ("_order");
  CREATE INDEX "forms_blocks_checkbox_parent_id_idx" ON "forms_blocks_checkbox" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_checkbox_path_idx" ON "forms_blocks_checkbox" USING btree ("_path");
  CREATE INDEX "forms_blocks_email_order_idx" ON "forms_blocks_email" USING btree ("_order");
  CREATE INDEX "forms_blocks_email_parent_id_idx" ON "forms_blocks_email" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_email_path_idx" ON "forms_blocks_email" USING btree ("_path");
  CREATE INDEX "forms_blocks_message_order_idx" ON "forms_blocks_message" USING btree ("_order");
  CREATE INDEX "forms_blocks_message_parent_id_idx" ON "forms_blocks_message" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_message_path_idx" ON "forms_blocks_message" USING btree ("_path");
  CREATE INDEX "forms_blocks_number_order_idx" ON "forms_blocks_number" USING btree ("_order");
  CREATE INDEX "forms_blocks_number_parent_id_idx" ON "forms_blocks_number" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_number_path_idx" ON "forms_blocks_number" USING btree ("_path");
  CREATE INDEX "forms_blocks_select_options_order_idx" ON "forms_blocks_select_options" USING btree ("_order");
  CREATE INDEX "forms_blocks_select_options_parent_id_idx" ON "forms_blocks_select_options" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_select_order_idx" ON "forms_blocks_select" USING btree ("_order");
  CREATE INDEX "forms_blocks_select_parent_id_idx" ON "forms_blocks_select" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_select_path_idx" ON "forms_blocks_select" USING btree ("_path");
  CREATE INDEX "forms_blocks_text_order_idx" ON "forms_blocks_text" USING btree ("_order");
  CREATE INDEX "forms_blocks_text_parent_id_idx" ON "forms_blocks_text" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_text_path_idx" ON "forms_blocks_text" USING btree ("_path");
  CREATE INDEX "forms_blocks_textarea_order_idx" ON "forms_blocks_textarea" USING btree ("_order");
  CREATE INDEX "forms_blocks_textarea_parent_id_idx" ON "forms_blocks_textarea" USING btree ("_parent_id");
  CREATE INDEX "forms_blocks_textarea_path_idx" ON "forms_blocks_textarea" USING btree ("_path");
  CREATE INDEX "forms_emails_order_idx" ON "forms_emails" USING btree ("_order");
  CREATE INDEX "forms_emails_parent_id_idx" ON "forms_emails" USING btree ("_parent_id");
  CREATE INDEX "forms_updated_at_idx" ON "forms" USING btree ("updated_at");
  CREATE INDEX "forms_created_at_idx" ON "forms" USING btree ("created_at");
  CREATE INDEX "forms_rels_order_idx" ON "forms_rels" USING btree ("order");
  CREATE INDEX "forms_rels_parent_idx" ON "forms_rels" USING btree ("parent_id");
  CREATE INDEX "forms_rels_path_idx" ON "forms_rels" USING btree ("path");
  CREATE INDEX "forms_rels_articles_id_idx" ON "forms_rels" USING btree ("articles_id");
  CREATE INDEX "forms_rels_topics_id_idx" ON "forms_rels" USING btree ("topics_id");
  CREATE INDEX "forms_rels_tld_pages_id_idx" ON "forms_rels" USING btree ("tld_pages_id");
  CREATE INDEX "form_submissions_submission_data_order_idx" ON "form_submissions_submission_data" USING btree ("_order");
  CREATE INDEX "form_submissions_submission_data_parent_id_idx" ON "form_submissions_submission_data" USING btree ("_parent_id");
  CREATE INDEX "form_submissions_form_idx" ON "form_submissions" USING btree ("form_id");
  CREATE INDEX "form_submissions_updated_at_idx" ON "form_submissions" USING btree ("updated_at");
  CREATE INDEX "form_submissions_created_at_idx" ON "form_submissions" USING btree ("created_at");
  CREATE UNIQUE INDEX "payload_kv_key_idx" ON "payload_kv" USING btree ("key");
  CREATE INDEX "payload_jobs_log_order_idx" ON "payload_jobs_log" USING btree ("_order");
  CREATE INDEX "payload_jobs_log_parent_id_idx" ON "payload_jobs_log" USING btree ("_parent_id");
  CREATE INDEX "payload_jobs_completed_at_idx" ON "payload_jobs" USING btree ("completed_at");
  CREATE INDEX "payload_jobs_total_tried_idx" ON "payload_jobs" USING btree ("total_tried");
  CREATE INDEX "payload_jobs_has_error_idx" ON "payload_jobs" USING btree ("has_error");
  CREATE INDEX "payload_jobs_workflow_slug_idx" ON "payload_jobs" USING btree ("workflow_slug");
  CREATE INDEX "payload_jobs_task_slug_idx" ON "payload_jobs" USING btree ("task_slug");
  CREATE INDEX "payload_jobs_queue_idx" ON "payload_jobs" USING btree ("queue");
  CREATE INDEX "payload_jobs_wait_until_idx" ON "payload_jobs" USING btree ("wait_until");
  CREATE INDEX "payload_jobs_processing_idx" ON "payload_jobs" USING btree ("processing");
  CREATE INDEX "payload_jobs_concurrency_key_idx" ON "payload_jobs" USING btree ("concurrency_key");
  CREATE INDEX "payload_jobs_updated_at_idx" ON "payload_jobs" USING btree ("updated_at");
  CREATE INDEX "payload_jobs_created_at_idx" ON "payload_jobs" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_global_slug_idx" ON "payload_locked_documents" USING btree ("global_slug");
  CREATE INDEX "payload_locked_documents_updated_at_idx" ON "payload_locked_documents" USING btree ("updated_at");
  CREATE INDEX "payload_locked_documents_created_at_idx" ON "payload_locked_documents" USING btree ("created_at");
  CREATE INDEX "payload_locked_documents_rels_order_idx" ON "payload_locked_documents_rels" USING btree ("order");
  CREATE INDEX "payload_locked_documents_rels_parent_idx" ON "payload_locked_documents_rels" USING btree ("parent_id");
  CREATE INDEX "payload_locked_documents_rels_path_idx" ON "payload_locked_documents_rels" USING btree ("path");
  CREATE INDEX "payload_locked_documents_rels_admins_id_idx" ON "payload_locked_documents_rels" USING btree ("admins_id");
  CREATE INDEX "payload_locked_documents_rels_customers_id_idx" ON "payload_locked_documents_rels" USING btree ("customers_id");
  CREATE INDEX "payload_locked_documents_rels_sms_challenges_id_idx" ON "payload_locked_documents_rels" USING btree ("sms_challenges_id");
  CREATE INDEX "payload_locked_documents_rels_customer_sessions_id_idx" ON "payload_locked_documents_rels" USING btree ("customer_sessions_id");
  CREATE INDEX "payload_locked_documents_rels_articles_id_idx" ON "payload_locked_documents_rels" USING btree ("articles_id");
  CREATE INDEX "payload_locked_documents_rels_topics_id_idx" ON "payload_locked_documents_rels" USING btree ("topics_id");
  CREATE INDEX "payload_locked_documents_rels_tld_pages_id_idx" ON "payload_locked_documents_rels" USING btree ("tld_pages_id");
  CREATE INDEX "payload_locked_documents_rels_media_id_idx" ON "payload_locked_documents_rels" USING btree ("media_id");
  CREATE INDEX "payload_locked_documents_rels_navigation_id_idx" ON "payload_locked_documents_rels" USING btree ("navigation_id");
  CREATE INDEX "payload_locked_documents_rels_site_settings_id_idx" ON "payload_locked_documents_rels" USING btree ("site_settings_id");
  CREATE INDEX "payload_locked_documents_rels_advertisers_id_idx" ON "payload_locked_documents_rels" USING btree ("advertisers_id");
  CREATE INDEX "payload_locked_documents_rels_ad_creatives_id_idx" ON "payload_locked_documents_rels" USING btree ("ad_creatives_id");
  CREATE INDEX "payload_locked_documents_rels_ad_placements_id_idx" ON "payload_locked_documents_rels" USING btree ("ad_placements_id");
  CREATE INDEX "payload_locked_documents_rels_ad_schedules_id_idx" ON "payload_locked_documents_rels" USING btree ("ad_schedules_id");
  CREATE INDEX "payload_locked_documents_rels_realname_templates_id_idx" ON "payload_locked_documents_rels" USING btree ("realname_templates_id");
  CREATE INDEX "payload_locked_documents_rels_realname_documents_id_idx" ON "payload_locked_documents_rels" USING btree ("realname_documents_id");
  CREATE INDEX "payload_locked_documents_rels_price_rules_id_idx" ON "payload_locked_documents_rels" USING btree ("price_rules_id");
  CREATE INDEX "payload_locked_documents_rels_quotes_id_idx" ON "payload_locked_documents_rels" USING btree ("quotes_id");
  CREATE INDEX "payload_locked_documents_rels_orders_id_idx" ON "payload_locked_documents_rels" USING btree ("orders_id");
  CREATE INDEX "payload_locked_documents_rels_order_events_id_idx" ON "payload_locked_documents_rels" USING btree ("order_events_id");
  CREATE INDEX "payload_locked_documents_rels_payment_notifications_id_idx" ON "payload_locked_documents_rels" USING btree ("payment_notifications_id");
  CREATE INDEX "payload_locked_documents_rels_refunds_id_idx" ON "payload_locked_documents_rels" USING btree ("refunds_id");
  CREATE INDEX "payload_locked_documents_rels_provider_operations_id_idx" ON "payload_locked_documents_rels" USING btree ("provider_operations_id");
  CREATE INDEX "payload_locked_documents_rels_domain_assets_id_idx" ON "payload_locked_documents_rels" USING btree ("domain_assets_id");
  CREATE INDEX "payload_locked_documents_rels_renewals_id_idx" ON "payload_locked_documents_rels" USING btree ("renewals_id");
  CREATE INDEX "payload_locked_documents_rels_nameserver_changes_id_idx" ON "payload_locked_documents_rels" USING btree ("nameserver_changes_id");
  CREATE INDEX "payload_locked_documents_rels_manual_reviews_id_idx" ON "payload_locked_documents_rels" USING btree ("manual_reviews_id");
  CREATE INDEX "payload_locked_documents_rels_reconciliations_id_idx" ON "payload_locked_documents_rels" USING btree ("reconciliations_id");
  CREATE INDEX "payload_locked_documents_rels_audit_logs_id_idx" ON "payload_locked_documents_rels" USING btree ("audit_logs_id");
  CREATE INDEX "payload_locked_documents_rels_user_feedback_id_idx" ON "payload_locked_documents_rels" USING btree ("user_feedback_id");
  CREATE INDEX "payload_locked_documents_rels_customer_security_events_i_idx" ON "payload_locked_documents_rels" USING btree ("customer_security_events_id");
  CREATE INDEX "payload_locked_documents_rels_redirects_id_idx" ON "payload_locked_documents_rels" USING btree ("redirects_id");
  CREATE INDEX "payload_locked_documents_rels_forms_id_idx" ON "payload_locked_documents_rels" USING btree ("forms_id");
  CREATE INDEX "payload_locked_documents_rels_form_submissions_id_idx" ON "payload_locked_documents_rels" USING btree ("form_submissions_id");
  CREATE INDEX "payload_preferences_key_idx" ON "payload_preferences" USING btree ("key");
  CREATE INDEX "payload_preferences_updated_at_idx" ON "payload_preferences" USING btree ("updated_at");
  CREATE INDEX "payload_preferences_created_at_idx" ON "payload_preferences" USING btree ("created_at");
  CREATE INDEX "payload_preferences_rels_order_idx" ON "payload_preferences_rels" USING btree ("order");
  CREATE INDEX "payload_preferences_rels_parent_idx" ON "payload_preferences_rels" USING btree ("parent_id");
  CREATE INDEX "payload_preferences_rels_path_idx" ON "payload_preferences_rels" USING btree ("path");
  CREATE INDEX "payload_preferences_rels_admins_id_idx" ON "payload_preferences_rels" USING btree ("admins_id");
  CREATE INDEX "payload_preferences_rels_customers_id_idx" ON "payload_preferences_rels" USING btree ("customers_id");
  CREATE INDEX "payload_migrations_updated_at_idx" ON "payload_migrations" USING btree ("updated_at");
  CREATE INDEX "payload_migrations_created_at_idx" ON "payload_migrations" USING btree ("created_at");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "admins_roles" CASCADE;
  DROP TABLE "admins_sessions" CASCADE;
  DROP TABLE "admins" CASCADE;
  DROP TABLE "admins_texts" CASCADE;
  DROP TABLE "customers" CASCADE;
  DROP TABLE "sms_challenges" CASCADE;
  DROP TABLE "customer_sessions" CASCADE;
  DROP TABLE "articles" CASCADE;
  DROP TABLE "_articles_v" CASCADE;
  DROP TABLE "topics" CASCADE;
  DROP TABLE "_topics_v" CASCADE;
  DROP TABLE "tld_pages" CASCADE;
  DROP TABLE "_tld_pages_v" CASCADE;
  DROP TABLE "media" CASCADE;
  DROP TABLE "navigation" CASCADE;
  DROP TABLE "site_settings" CASCADE;
  DROP TABLE "advertisers" CASCADE;
  DROP TABLE "ad_creatives" CASCADE;
  DROP TABLE "ad_placements" CASCADE;
  DROP TABLE "ad_schedules" CASCADE;
  DROP TABLE "realname_templates" CASCADE;
  DROP TABLE "realname_documents" CASCADE;
  DROP TABLE "price_rules" CASCADE;
  DROP TABLE "quotes" CASCADE;
  DROP TABLE "orders" CASCADE;
  DROP TABLE "order_events" CASCADE;
  DROP TABLE "payment_notifications" CASCADE;
  DROP TABLE "refunds" CASCADE;
  DROP TABLE "provider_operations" CASCADE;
  DROP TABLE "domain_assets" CASCADE;
  DROP TABLE "domain_assets_texts" CASCADE;
  DROP TABLE "renewals" CASCADE;
  DROP TABLE "nameserver_changes" CASCADE;
  DROP TABLE "nameserver_changes_texts" CASCADE;
  DROP TABLE "manual_reviews" CASCADE;
  DROP TABLE "reconciliations" CASCADE;
  DROP TABLE "audit_logs" CASCADE;
  DROP TABLE "user_feedback" CASCADE;
  DROP TABLE "customer_security_events" CASCADE;
  DROP TABLE "redirects" CASCADE;
  DROP TABLE "redirects_rels" CASCADE;
  DROP TABLE "forms_blocks_checkbox" CASCADE;
  DROP TABLE "forms_blocks_email" CASCADE;
  DROP TABLE "forms_blocks_message" CASCADE;
  DROP TABLE "forms_blocks_number" CASCADE;
  DROP TABLE "forms_blocks_select_options" CASCADE;
  DROP TABLE "forms_blocks_select" CASCADE;
  DROP TABLE "forms_blocks_text" CASCADE;
  DROP TABLE "forms_blocks_textarea" CASCADE;
  DROP TABLE "forms_emails" CASCADE;
  DROP TABLE "forms" CASCADE;
  DROP TABLE "forms_rels" CASCADE;
  DROP TABLE "form_submissions_submission_data" CASCADE;
  DROP TABLE "form_submissions" CASCADE;
  DROP TABLE "payload_kv" CASCADE;
  DROP TABLE "payload_jobs_log" CASCADE;
  DROP TABLE "payload_jobs" CASCADE;
  DROP TABLE "payload_locked_documents" CASCADE;
  DROP TABLE "payload_locked_documents_rels" CASCADE;
  DROP TABLE "payload_preferences" CASCADE;
  DROP TABLE "payload_preferences_rels" CASCADE;
  DROP TABLE "payload_migrations" CASCADE;
  DROP TYPE "public"."enum_admins_roles";
  DROP TYPE "public"."enum_customers_status";
  DROP TYPE "public"."enum_articles_status";
  DROP TYPE "public"."enum__articles_v_version_status";
  DROP TYPE "public"."enum_topics_status";
  DROP TYPE "public"."enum__topics_v_version_status";
  DROP TYPE "public"."enum_tld_pages_status";
  DROP TYPE "public"."enum__tld_pages_v_version_status";
  DROP TYPE "public"."enum_advertisers_status";
  DROP TYPE "public"."enum_ad_creatives_status";
  DROP TYPE "public"."enum_ad_schedules_status";
  DROP TYPE "public"."enum_realname_templates_type";
  DROP TYPE "public"."enum_realname_templates_status";
  DROP TYPE "public"."enum_price_rules_mode";
  DROP TYPE "public"."enum_quotes_currency";
  DROP TYPE "public"."enum_orders_status";
  DROP TYPE "public"."enum_orders_currency";
  DROP TYPE "public"."enum_order_events_from_status";
  DROP TYPE "public"."enum_order_events_to_status";
  DROP TYPE "public"."enum_order_events_actor_type";
  DROP TYPE "public"."enum_refunds_status";
  DROP TYPE "public"."enum_provider_operations_provider";
  DROP TYPE "public"."enum_provider_operations_operation";
  DROP TYPE "public"."enum_provider_operations_status";
  DROP TYPE "public"."enum_domain_assets_status";
  DROP TYPE "public"."enum_renewals_status";
  DROP TYPE "public"."enum_nameserver_changes_status";
  DROP TYPE "public"."enum_manual_reviews_status";
  DROP TYPE "public"."enum_reconciliations_kind";
  DROP TYPE "public"."enum_reconciliations_status";
  DROP TYPE "public"."enum_audit_logs_actor_type";
  DROP TYPE "public"."enum_user_feedback_category";
  DROP TYPE "public"."enum_user_feedback_status";
  DROP TYPE "public"."enum_redirects_to_type";
  DROP TYPE "public"."enum_redirects_type";
  DROP TYPE "public"."enum_forms_confirmation_type";
  DROP TYPE "public"."enum_forms_redirect_type";
  DROP TYPE "public"."enum_forms_purpose";
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  DROP TYPE "public"."enum_payload_jobs_log_state";
  DROP TYPE "public"."enum_payload_jobs_log_parent_task_slug";
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  DROP TYPE "public"."enum_payload_jobs_task_slug";`)
}
