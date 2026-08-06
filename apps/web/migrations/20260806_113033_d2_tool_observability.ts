import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_tool_observability_buckets_scope" AS ENUM('tool', 'provider');
  CREATE TYPE "public"."enum_tool_observability_buckets_tool" AS ENUM('domain-search', 'whois', 'dns', 'ssl-check', 'idn', 'pricing');
  CREATE TYPE "public"."enum_tool_observability_buckets_provider" AS ENUM('westdigital', 'whodat', 'alidns', 'node_tls');
  CREATE TYPE "public"."enum_tool_observability_buckets_provider_operation" AS ENUM('availability', 'price', 'whois', 'dns', 'tls');
  CREATE TYPE "public"."enum_tool_observability_buckets_p50_bucket" AS ENUM('lt_100ms', '100_299ms', '300_999ms', '1000_2999ms', '3000_9999ms', 'gte_10000ms');
  CREATE TYPE "public"."enum_tool_observability_buckets_p95_bucket" AS ENUM('lt_100ms', '100_299ms', '300_999ms', '1000_2999ms', '3000_9999ms', 'gte_10000ms');
  CREATE TABLE "tool_observability_buckets" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"schema_version" numeric DEFAULT 1 NOT NULL,
  	"bucket_key" varchar NOT NULL,
  	"bucket_start" timestamp(3) with time zone NOT NULL,
  	"bucket_end" timestamp(3) with time zone NOT NULL,
  	"last_observed_at" timestamp(3) with time zone NOT NULL,
  	"scope" "enum_tool_observability_buckets_scope" NOT NULL,
  	"tool" "enum_tool_observability_buckets_tool",
  	"provider" "enum_tool_observability_buckets_provider",
  	"provider_operation" "enum_tool_observability_buckets_provider_operation",
  	"request_count" numeric DEFAULT 0 NOT NULL,
  	"success_count" numeric DEFAULT 0 NOT NULL,
  	"failure_count" numeric DEFAULT 0 NOT NULL,
  	"success_rate_basis_points" numeric DEFAULT 0 NOT NULL,
  	"p50_bucket" "enum_tool_observability_buckets_p50_bucket",
  	"p95_bucket" "enum_tool_observability_buckets_p95_bucket",
  	"latency_lt100_ms_count" numeric DEFAULT 0 NOT NULL,
  	"latency100_to299_ms_count" numeric DEFAULT 0 NOT NULL,
  	"latency300_to999_ms_count" numeric DEFAULT 0 NOT NULL,
  	"latency1000_to2999_ms_count" numeric DEFAULT 0 NOT NULL,
  	"latency3000_to9999_ms_count" numeric DEFAULT 0 NOT NULL,
  	"latency_gte10000_ms_count" numeric DEFAULT 0 NOT NULL,
  	"timeout_error_count" numeric DEFAULT 0 NOT NULL,
  	"rate_limited_error_count" numeric DEFAULT 0 NOT NULL,
  	"upstream_error_count" numeric DEFAULT 0 NOT NULL,
  	"invalid_response_error_count" numeric DEFAULT 0 NOT NULL,
  	"last_queue_depth" numeric DEFAULT 0 NOT NULL,
  	"max_queue_depth" numeric DEFAULT 0 NOT NULL,
  	"rejected_count" numeric DEFAULT 0 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE UNIQUE INDEX "tool_observability_buckets_bucket_key_idx" ON "tool_observability_buckets" USING btree ("bucket_key");
  CREATE INDEX "tool_observability_buckets_bucket_start_idx" ON "tool_observability_buckets" USING btree ("bucket_start");
  CREATE INDEX "tool_observability_buckets_updated_at_idx" ON "tool_observability_buckets" USING btree ("updated_at");
  CREATE INDEX "tool_observability_buckets_created_at_idx" ON "tool_observability_buckets" USING btree ("created_at");
  CREATE INDEX "scope_bucketStart_idx" ON "tool_observability_buckets" USING btree ("scope","bucket_start");
  CREATE INDEX "tool_bucketStart_idx" ON "tool_observability_buckets" USING btree ("tool","bucket_start");
  CREATE INDEX "provider_bucketStart_idx" ON "tool_observability_buckets" USING btree ("provider","bucket_start");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TABLE "tool_observability_buckets" CASCADE;
  DROP TYPE "public"."enum_tool_observability_buckets_scope";
  DROP TYPE "public"."enum_tool_observability_buckets_tool";
  DROP TYPE "public"."enum_tool_observability_buckets_provider";
  DROP TYPE "public"."enum_tool_observability_buckets_provider_operation";
  DROP TYPE "public"."enum_tool_observability_buckets_p50_bucket";
  DROP TYPE "public"."enum_tool_observability_buckets_p95_bucket";`)
}
