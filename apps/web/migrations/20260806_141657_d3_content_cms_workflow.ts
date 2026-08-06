import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_articles_workflow_status" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');
  CREATE TYPE "public"."enum__articles_v_version_workflow_status" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');
  CREATE TYPE "public"."enum_topics_workflow_status" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');
  CREATE TYPE "public"."enum__topics_v_version_workflow_status" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');
  CREATE TYPE "public"."enum_tld_pages_workflow_status" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');
  CREATE TYPE "public"."enum__tld_pages_v_version_workflow_status" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');
  CREATE TYPE "public"."enum_help_pages_workflow_status" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');
  CREATE TYPE "public"."enum_help_pages_status" AS ENUM('draft', 'published');
  CREATE TYPE "public"."enum__help_pages_v_version_workflow_status" AS ENUM('draft', 'in_review', 'published', 'unpublished', 'archived');
  CREATE TYPE "public"."enum__help_pages_v_version_status" AS ENUM('draft', 'published');
  ALTER TYPE "public"."enum_payload_jobs_workflow_slug" ADD VALUE 'contentScheduledPublish' BEFORE 'backgroundProbe';
  CREATE TABLE "articles_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"categories_id" integer,
  	"tags_id" integer
  );
  
  CREATE TABLE "_articles_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"categories_id" integer,
  	"tags_id" integer
  );
  
  CREATE TABLE "help_pages" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar,
  	"slug" varchar,
  	"summary" varchar,
  	"content" jsonb,
  	"source" varchar,
  	"workflow_status" "enum_help_pages_workflow_status" DEFAULT 'draft',
  	"scheduled_publish_at" timestamp(3) with time zone,
  	"published_at" timestamp(3) with time zone,
  	"revision_by" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"_status" "enum_help_pages_status" DEFAULT 'draft'
  );
  
  CREATE TABLE "_help_pages_v" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"parent_id" integer,
  	"version_title" varchar,
  	"version_slug" varchar,
  	"version_summary" varchar,
  	"version_content" jsonb,
  	"version_source" varchar,
  	"version_workflow_status" "enum__help_pages_v_version_workflow_status" DEFAULT 'draft',
  	"version_scheduled_publish_at" timestamp(3) with time zone,
  	"version_published_at" timestamp(3) with time zone,
  	"version_revision_by" varchar,
  	"version_updated_at" timestamp(3) with time zone,
  	"version_created_at" timestamp(3) with time zone,
  	"version__status" "enum__help_pages_v_version_status" DEFAULT 'draft',
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"latest" boolean,
  	"autosave" boolean
  );
  
  CREATE TABLE "categories" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"description" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "tags" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"description" varchar,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  DELETE FROM "payload_jobs" WHERE "task_slug" = 'schedulePublish';
  DELETE FROM "payload_jobs_log"
    WHERE "task_slug" = 'schedulePublish' OR "parent_task_slug" = 'schedulePublish';
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_task_slug" AS ENUM('inline');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_task_slug" USING "task_slug"::"public"."enum_payload_jobs_log_task_slug";
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_log_parent_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_log_parent_task_slug" AS ENUM('inline');
  ALTER TABLE "payload_jobs_log" ALTER COLUMN "parent_task_slug" SET DATA TYPE "public"."enum_payload_jobs_log_parent_task_slug" USING "parent_task_slug"::"public"."enum_payload_jobs_log_parent_task_slug";
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_task_slug";
  CREATE TYPE "public"."enum_payload_jobs_task_slug" AS ENUM('inline');
  ALTER TABLE "payload_jobs" ALTER COLUMN "task_slug" SET DATA TYPE "public"."enum_payload_jobs_task_slug" USING "task_slug"::"public"."enum_payload_jobs_task_slug";
  ALTER TABLE "articles" ADD COLUMN "workflow_status" "enum_articles_workflow_status" DEFAULT 'draft';
  ALTER TABLE "articles" ADD COLUMN "scheduled_publish_at" timestamp(3) with time zone;
  ALTER TABLE "articles" ADD COLUMN "revision_by" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_workflow_status" "enum__articles_v_version_workflow_status" DEFAULT 'draft';
  ALTER TABLE "_articles_v" ADD COLUMN "version_scheduled_publish_at" timestamp(3) with time zone;
  ALTER TABLE "_articles_v" ADD COLUMN "version_revision_by" varchar;
  ALTER TABLE "topics" ADD COLUMN "workflow_status" "enum_topics_workflow_status" DEFAULT 'draft';
  ALTER TABLE "topics" ADD COLUMN "scheduled_publish_at" timestamp(3) with time zone;
  ALTER TABLE "topics" ADD COLUMN "revision_by" varchar;
  ALTER TABLE "_topics_v" ADD COLUMN "version_workflow_status" "enum__topics_v_version_workflow_status" DEFAULT 'draft';
  ALTER TABLE "_topics_v" ADD COLUMN "version_scheduled_publish_at" timestamp(3) with time zone;
  ALTER TABLE "_topics_v" ADD COLUMN "version_revision_by" varchar;
  ALTER TABLE "tld_pages" ADD COLUMN "workflow_status" "enum_tld_pages_workflow_status" DEFAULT 'draft';
  ALTER TABLE "tld_pages" ADD COLUMN "scheduled_publish_at" timestamp(3) with time zone;
  ALTER TABLE "tld_pages" ADD COLUMN "revision_by" varchar;
  ALTER TABLE "_tld_pages_v" ADD COLUMN "version_workflow_status" "enum__tld_pages_v_version_workflow_status" DEFAULT 'draft';
  ALTER TABLE "_tld_pages_v" ADD COLUMN "version_scheduled_publish_at" timestamp(3) with time zone;
  ALTER TABLE "_tld_pages_v" ADD COLUMN "version_revision_by" varchar;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "help_pages_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "categories_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "tags_id" integer;
  UPDATE "articles"
    SET "workflow_status" = CASE
      WHEN "_status" = 'published' AND NULLIF(BTRIM("source"), '') IS NOT NULL
        THEN 'published'::"enum_articles_workflow_status"
      WHEN "_status" = 'published'
        THEN 'in_review'::"enum_articles_workflow_status"
      ELSE 'draft'::"enum_articles_workflow_status"
    END,
    "_status" = CASE
      WHEN "_status" = 'published' AND NULLIF(BTRIM("source"), '') IS NULL
        THEN 'draft'::"enum_articles_status"
      ELSE "_status"
    END;
  UPDATE "_articles_v"
    SET "version_workflow_status" = CASE
      WHEN "version__status" = 'published' AND NULLIF(BTRIM("version_source"), '') IS NOT NULL
        THEN 'published'::"enum__articles_v_version_workflow_status"
      WHEN "version__status" = 'published'
        THEN 'in_review'::"enum__articles_v_version_workflow_status"
      ELSE 'draft'::"enum__articles_v_version_workflow_status"
    END,
    "version__status" = CASE
      WHEN "version__status" = 'published' AND NULLIF(BTRIM("version_source"), '') IS NULL
        THEN 'draft'::"enum__articles_v_version_status"
      ELSE "version__status"
    END;
  UPDATE "topics"
    SET "workflow_status" = CASE
      WHEN "_status" = 'published' AND NULLIF(BTRIM("source"), '') IS NOT NULL
        THEN 'published'::"enum_topics_workflow_status"
      WHEN "_status" = 'published'
        THEN 'in_review'::"enum_topics_workflow_status"
      ELSE 'draft'::"enum_topics_workflow_status"
    END,
    "_status" = CASE
      WHEN "_status" = 'published' AND NULLIF(BTRIM("source"), '') IS NULL
        THEN 'draft'::"enum_topics_status"
      ELSE "_status"
    END;
  UPDATE "_topics_v"
    SET "version_workflow_status" = CASE
      WHEN "version__status" = 'published' AND NULLIF(BTRIM("version_source"), '') IS NOT NULL
        THEN 'published'::"enum__topics_v_version_workflow_status"
      WHEN "version__status" = 'published'
        THEN 'in_review'::"enum__topics_v_version_workflow_status"
      ELSE 'draft'::"enum__topics_v_version_workflow_status"
    END,
    "version__status" = CASE
      WHEN "version__status" = 'published' AND NULLIF(BTRIM("version_source"), '') IS NULL
        THEN 'draft'::"enum__topics_v_version_status"
      ELSE "version__status"
    END;
  UPDATE "tld_pages"
    SET "workflow_status" = CASE
      WHEN "_status" = 'published' AND NULLIF(BTRIM("source"), '') IS NOT NULL
        THEN 'published'::"enum_tld_pages_workflow_status"
      WHEN "_status" = 'published'
        THEN 'in_review'::"enum_tld_pages_workflow_status"
      ELSE 'draft'::"enum_tld_pages_workflow_status"
    END,
    "_status" = CASE
      WHEN "_status" = 'published' AND NULLIF(BTRIM("source"), '') IS NULL
        THEN 'draft'::"enum_tld_pages_status"
      ELSE "_status"
    END;
  UPDATE "_tld_pages_v"
    SET "version_workflow_status" = CASE
      WHEN "version__status" = 'published' AND NULLIF(BTRIM("version_source"), '') IS NOT NULL
        THEN 'published'::"enum__tld_pages_v_version_workflow_status"
      WHEN "version__status" = 'published'
        THEN 'in_review'::"enum__tld_pages_v_version_workflow_status"
      ELSE 'draft'::"enum__tld_pages_v_version_workflow_status"
    END,
    "version__status" = CASE
      WHEN "version__status" = 'published' AND NULLIF(BTRIM("version_source"), '') IS NULL
        THEN 'draft'::"enum__tld_pages_v_version_status"
      ELSE "version__status"
    END;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."articles"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_categories_fk" FOREIGN KEY ("categories_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_articles_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_categories_fk" FOREIGN KEY ("categories_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_help_pages_v" ADD CONSTRAINT "_help_pages_v_parent_id_help_pages_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."help_pages"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "articles_rels_order_idx" ON "articles_rels" USING btree ("order");
  CREATE INDEX "articles_rels_parent_idx" ON "articles_rels" USING btree ("parent_id");
  CREATE INDEX "articles_rels_path_idx" ON "articles_rels" USING btree ("path");
  CREATE INDEX "articles_rels_categories_id_idx" ON "articles_rels" USING btree ("categories_id");
  CREATE INDEX "articles_rels_tags_id_idx" ON "articles_rels" USING btree ("tags_id");
  CREATE INDEX "_articles_v_rels_order_idx" ON "_articles_v_rels" USING btree ("order");
  CREATE INDEX "_articles_v_rels_parent_idx" ON "_articles_v_rels" USING btree ("parent_id");
  CREATE INDEX "_articles_v_rels_path_idx" ON "_articles_v_rels" USING btree ("path");
  CREATE INDEX "_articles_v_rels_categories_id_idx" ON "_articles_v_rels" USING btree ("categories_id");
  CREATE INDEX "_articles_v_rels_tags_id_idx" ON "_articles_v_rels" USING btree ("tags_id");
  CREATE UNIQUE INDEX "help_pages_slug_idx" ON "help_pages" USING btree ("slug");
  CREATE INDEX "help_pages_workflow_status_idx" ON "help_pages" USING btree ("workflow_status");
  CREATE INDEX "help_pages_scheduled_publish_at_idx" ON "help_pages" USING btree ("scheduled_publish_at");
  CREATE INDEX "help_pages_published_at_idx" ON "help_pages" USING btree ("published_at");
  CREATE INDEX "help_pages_updated_at_idx" ON "help_pages" USING btree ("updated_at");
  CREATE INDEX "help_pages_created_at_idx" ON "help_pages" USING btree ("created_at");
  CREATE INDEX "help_pages__status_idx" ON "help_pages" USING btree ("_status");
  CREATE INDEX "_help_pages_v_parent_idx" ON "_help_pages_v" USING btree ("parent_id");
  CREATE INDEX "_help_pages_v_version_version_slug_idx" ON "_help_pages_v" USING btree ("version_slug");
  CREATE INDEX "_help_pages_v_version_version_workflow_status_idx" ON "_help_pages_v" USING btree ("version_workflow_status");
  CREATE INDEX "_help_pages_v_version_version_scheduled_publish_at_idx" ON "_help_pages_v" USING btree ("version_scheduled_publish_at");
  CREATE INDEX "_help_pages_v_version_version_published_at_idx" ON "_help_pages_v" USING btree ("version_published_at");
  CREATE INDEX "_help_pages_v_version_version_updated_at_idx" ON "_help_pages_v" USING btree ("version_updated_at");
  CREATE INDEX "_help_pages_v_version_version_created_at_idx" ON "_help_pages_v" USING btree ("version_created_at");
  CREATE INDEX "_help_pages_v_version_version__status_idx" ON "_help_pages_v" USING btree ("version__status");
  CREATE INDEX "_help_pages_v_created_at_idx" ON "_help_pages_v" USING btree ("created_at");
  CREATE INDEX "_help_pages_v_updated_at_idx" ON "_help_pages_v" USING btree ("updated_at");
  CREATE INDEX "_help_pages_v_latest_idx" ON "_help_pages_v" USING btree ("latest");
  CREATE INDEX "_help_pages_v_autosave_idx" ON "_help_pages_v" USING btree ("autosave");
  CREATE UNIQUE INDEX "categories_slug_idx" ON "categories" USING btree ("slug");
  CREATE INDEX "categories_updated_at_idx" ON "categories" USING btree ("updated_at");
  CREATE INDEX "categories_created_at_idx" ON "categories" USING btree ("created_at");
  CREATE UNIQUE INDEX "tags_slug_idx" ON "tags" USING btree ("slug");
  CREATE INDEX "tags_updated_at_idx" ON "tags" USING btree ("updated_at");
  CREATE INDEX "tags_created_at_idx" ON "tags" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_help_pages_fk" FOREIGN KEY ("help_pages_id") REFERENCES "public"."help_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_categories_fk" FOREIGN KEY ("categories_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "articles_workflow_status_idx" ON "articles" USING btree ("workflow_status");
  CREATE INDEX "articles_scheduled_publish_at_idx" ON "articles" USING btree ("scheduled_publish_at");
  CREATE INDEX "_articles_v_version_version_workflow_status_idx" ON "_articles_v" USING btree ("version_workflow_status");
  CREATE INDEX "_articles_v_version_version_scheduled_publish_at_idx" ON "_articles_v" USING btree ("version_scheduled_publish_at");
  CREATE INDEX "topics_workflow_status_idx" ON "topics" USING btree ("workflow_status");
  CREATE INDEX "topics_scheduled_publish_at_idx" ON "topics" USING btree ("scheduled_publish_at");
  CREATE INDEX "_topics_v_version_version_workflow_status_idx" ON "_topics_v" USING btree ("version_workflow_status");
  CREATE INDEX "_topics_v_version_version_scheduled_publish_at_idx" ON "_topics_v" USING btree ("version_scheduled_publish_at");
  CREATE INDEX "tld_pages_workflow_status_idx" ON "tld_pages" USING btree ("workflow_status");
  CREATE INDEX "tld_pages_scheduled_publish_at_idx" ON "tld_pages" USING btree ("scheduled_publish_at");
  CREATE INDEX "_tld_pages_v_version_version_workflow_status_idx" ON "_tld_pages_v" USING btree ("version_workflow_status");
  CREATE INDEX "_tld_pages_v_version_version_scheduled_publish_at_idx" ON "_tld_pages_v" USING btree ("version_scheduled_publish_at");
  CREATE INDEX "payload_locked_documents_rels_help_pages_id_idx" ON "payload_locked_documents_rels" USING btree ("help_pages_id");
  CREATE INDEX "payload_locked_documents_rels_categories_id_idx" ON "payload_locked_documents_rels" USING btree ("categories_id");
  CREATE INDEX "payload_locked_documents_rels_tags_id_idx" ON "payload_locked_documents_rels" USING btree ("tags_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DELETE FROM "payload_jobs" WHERE "workflow_slug" = 'contentScheduledPublish';
   ALTER TYPE "public"."enum_payload_jobs_log_task_slug" ADD VALUE 'schedulePublish';
  ALTER TYPE "public"."enum_payload_jobs_log_parent_task_slug" ADD VALUE 'schedulePublish';
  ALTER TYPE "public"."enum_payload_jobs_task_slug" ADD VALUE 'schedulePublish';
  ALTER TABLE "articles_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_articles_v_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "help_pages" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_help_pages_v" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "categories" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "tags" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_help_pages_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_categories_fk";
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_tags_fk";
  DROP TABLE "articles_rels" CASCADE;
  DROP TABLE "_articles_v_rels" CASCADE;
  DROP TABLE "help_pages" CASCADE;
  DROP TABLE "_help_pages_v" CASCADE;
  DROP TABLE "categories" CASCADE;
  DROP TABLE "tags" CASCADE;
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE text;
  DROP TYPE "public"."enum_payload_jobs_workflow_slug";
  CREATE TYPE "public"."enum_payload_jobs_workflow_slug" AS ENUM('publishingProbe', 'backgroundProbe', 'commerceFulfillment');
  ALTER TABLE "payload_jobs" ALTER COLUMN "workflow_slug" SET DATA TYPE "public"."enum_payload_jobs_workflow_slug" USING "workflow_slug"::"public"."enum_payload_jobs_workflow_slug";
  DROP INDEX "articles_workflow_status_idx";
  DROP INDEX "articles_scheduled_publish_at_idx";
  DROP INDEX "_articles_v_version_version_workflow_status_idx";
  DROP INDEX "_articles_v_version_version_scheduled_publish_at_idx";
  DROP INDEX "topics_workflow_status_idx";
  DROP INDEX "topics_scheduled_publish_at_idx";
  DROP INDEX "_topics_v_version_version_workflow_status_idx";
  DROP INDEX "_topics_v_version_version_scheduled_publish_at_idx";
  DROP INDEX "tld_pages_workflow_status_idx";
  DROP INDEX "tld_pages_scheduled_publish_at_idx";
  DROP INDEX "_tld_pages_v_version_version_workflow_status_idx";
  DROP INDEX "_tld_pages_v_version_version_scheduled_publish_at_idx";
  DROP INDEX "payload_locked_documents_rels_help_pages_id_idx";
  DROP INDEX "payload_locked_documents_rels_categories_id_idx";
  DROP INDEX "payload_locked_documents_rels_tags_id_idx";
  ALTER TABLE "articles" DROP COLUMN "workflow_status";
  ALTER TABLE "articles" DROP COLUMN "scheduled_publish_at";
  ALTER TABLE "articles" DROP COLUMN "revision_by";
  ALTER TABLE "_articles_v" DROP COLUMN "version_workflow_status";
  ALTER TABLE "_articles_v" DROP COLUMN "version_scheduled_publish_at";
  ALTER TABLE "_articles_v" DROP COLUMN "version_revision_by";
  ALTER TABLE "topics" DROP COLUMN "workflow_status";
  ALTER TABLE "topics" DROP COLUMN "scheduled_publish_at";
  ALTER TABLE "topics" DROP COLUMN "revision_by";
  ALTER TABLE "_topics_v" DROP COLUMN "version_workflow_status";
  ALTER TABLE "_topics_v" DROP COLUMN "version_scheduled_publish_at";
  ALTER TABLE "_topics_v" DROP COLUMN "version_revision_by";
  ALTER TABLE "tld_pages" DROP COLUMN "workflow_status";
  ALTER TABLE "tld_pages" DROP COLUMN "scheduled_publish_at";
  ALTER TABLE "tld_pages" DROP COLUMN "revision_by";
  ALTER TABLE "_tld_pages_v" DROP COLUMN "version_workflow_status";
  ALTER TABLE "_tld_pages_v" DROP COLUMN "version_scheduled_publish_at";
  ALTER TABLE "_tld_pages_v" DROP COLUMN "version_revision_by";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "help_pages_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "categories_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "tags_id";
  DROP TYPE "public"."enum_articles_workflow_status";
  DROP TYPE "public"."enum__articles_v_version_workflow_status";
  DROP TYPE "public"."enum_topics_workflow_status";
  DROP TYPE "public"."enum__topics_v_version_workflow_status";
  DROP TYPE "public"."enum_tld_pages_workflow_status";
  DROP TYPE "public"."enum__tld_pages_v_version_workflow_status";
  DROP TYPE "public"."enum_help_pages_workflow_status";
  DROP TYPE "public"."enum_help_pages_status";
  DROP TYPE "public"."enum__help_pages_v_version_workflow_status";
  DROP TYPE "public"."enum__help_pages_v_version_status";`)
}
