import { MigrateDownArgs, MigrateUpArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
    CREATE TYPE "public"."enum_ad_creatives_creative_type" AS ENUM('image', 'text');
    CREATE TYPE "public"."enum_ad_creatives_target_type" AS ENUM('internal', 'external');
    CREATE TYPE "public"."enum_ad_placements_page_types" AS ENUM('home', 'tool', 'content', 'tld');
    CREATE TYPE "public"."enum_ad_placements_position" AS ENUM('after_core_result', 'content_inline', 'tld_inline', 'home_native');
    CREATE TYPE "public"."enum_ad_placements_device_scope" AS ENUM('all', 'desktop', 'mobile');

    ALTER TABLE "advertisers" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "advertisers" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
    DROP TYPE "public"."enum_advertisers_status";
    CREATE TYPE "public"."enum_advertisers_status" AS ENUM('draft', 'active', 'paused', 'disabled');
    ALTER TABLE "advertisers" ALTER COLUMN "status" SET DATA TYPE "public"."enum_advertisers_status" USING "status"::"public"."enum_advertisers_status";
    ALTER TABLE "advertisers" ALTER COLUMN "status" SET DEFAULT 'draft';

    ALTER TABLE "ad_creatives" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "ad_creatives" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
    DROP TYPE "public"."enum_ad_creatives_status";
    CREATE TYPE "public"."enum_ad_creatives_status" AS ENUM('draft', 'pending_review', 'approved', 'rejected', 'disabled');
    ALTER TABLE "ad_creatives" ALTER COLUMN "status" SET DATA TYPE "public"."enum_ad_creatives_status" USING "status"::"public"."enum_ad_creatives_status";
    ALTER TABLE "ad_creatives" ALTER COLUMN "status" SET DEFAULT 'draft';

    ALTER TABLE "ad_schedules" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "ad_schedules" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
    DROP TYPE "public"."enum_ad_schedules_status";
    CREATE TYPE "public"."enum_ad_schedules_status" AS ENUM('draft', 'scheduled', 'active', 'paused', 'ended', 'disabled');
    ALTER TABLE "ad_schedules" ALTER COLUMN "status" SET DATA TYPE "public"."enum_ad_schedules_status" USING "status"::"public"."enum_ad_schedules_status";
    ALTER TABLE "ad_schedules" ALTER COLUMN "status" SET DEFAULT 'draft';

    CREATE TABLE "advertisers_allowed_hosts" (
      "_order" integer NOT NULL,
      "_parent_id" integer NOT NULL,
      "id" varchar PRIMARY KEY NOT NULL,
      "host" varchar NOT NULL
    );

    CREATE TABLE "ad_media" (
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

    CREATE TABLE "ad_placements_page_types" (
      "order" integer NOT NULL,
      "parent_id" integer NOT NULL,
      "value" "enum_ad_placements_page_types",
      "id" serial PRIMARY KEY NOT NULL
    );

    ALTER TABLE "advertisers" ADD COLUMN "legal_name" varchar;
    ALTER TABLE "advertisers" ADD COLUMN "contact_name" varchar;
    ALTER TABLE "advertisers" ADD COLUMN "contact_email" varchar;
    ALTER TABLE "advertisers" ADD COLUMN "contract_reference" varchar;

    ALTER TABLE "ad_creatives" ADD COLUMN "creative_type" "enum_ad_creatives_creative_type" DEFAULT 'image' NOT NULL;
    ALTER TABLE "ad_creatives" ADD COLUMN "headline" varchar;
    ALTER TABLE "ad_creatives" ADD COLUMN "body" varchar;
    ALTER TABLE "ad_creatives" ADD COLUMN "target_type" "enum_ad_creatives_target_type";
    ALTER TABLE "ad_creatives" ADD COLUMN "review_notes" varchar;
    ALTER TABLE "ad_creatives" ADD COLUMN "reviewed_at" timestamp(3) with time zone;
    ALTER TABLE "ad_creatives" ADD COLUMN "reviewed_by" varchar;

    ALTER TABLE "ad_placements" ADD COLUMN "name" varchar;
    ALTER TABLE "ad_placements" ADD COLUMN "position" "enum_ad_placements_position";
    ALTER TABLE "ad_placements" ADD COLUMN "device_scope" "enum_ad_placements_device_scope" DEFAULT 'all' NOT NULL;
    ALTER TABLE "ad_placements" ADD COLUMN "width" numeric;
    ALTER TABLE "ad_placements" ADD COLUMN "height" numeric;
    ALTER TABLE "ad_placements" ALTER COLUMN "enabled" SET DEFAULT false;

    ALTER TABLE "ad_schedules" ADD COLUMN "public_id" varchar;
    ALTER TABLE "ad_schedules" ADD COLUMN "name" varchar;
    ALTER TABLE "ad_schedules" ADD COLUMN "advertiser_id" integer;
    ALTER TABLE "ad_schedules" ADD COLUMN "priority" numeric DEFAULT 0 NOT NULL;
    ALTER TABLE "ad_schedules" ADD COLUMN "notes" varchar;
    ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "ad_media_id" integer;

    INSERT INTO "ad_media" (
      "id", "alt", "source", "reviewed", "prefix", "updated_at", "created_at", "url",
      "thumbnail_u_r_l", "filename", "mime_type", "filesize", "width", "height", "focal_x", "focal_y"
    )
    SELECT
      media."id", media."alt", media."source", media."reviewed", media."prefix", media."updated_at",
      media."created_at", media."url", media."thumbnail_u_r_l", media."filename", media."mime_type",
      media."filesize", media."width", media."height", media."focal_x", media."focal_y"
    FROM "media"
    WHERE EXISTS (
      SELECT 1 FROM "ad_creatives" WHERE "ad_creatives"."image_id" = "media"."id"
    )
    ON CONFLICT ("id") DO NOTHING;

    SELECT setval(
      pg_get_serial_sequence('ad_media', 'id'),
      COALESCE((SELECT MAX("id") FROM "ad_media"), 1),
      EXISTS (SELECT 1 FROM "ad_media")
    );

    UPDATE "ad_creatives"
    SET
      "headline" = "name",
      "target_type" = CASE
        WHEN "target_url" LIKE 'https://%' THEN 'external'::"public"."enum_ad_creatives_target_type"
        ELSE 'internal'::"public"."enum_ad_creatives_target_type"
      END;

    UPDATE "ad_creatives"
    SET "status" = 'disabled'
    WHERE
      "target_type" = 'external'
      OR "target_url" NOT LIKE '/%'
      OR "target_url" LIKE '//%'
      OR position(chr(92) in "target_url") > 0
      OR position('?' in "target_url") > 0
      OR position('#' in "target_url") > 0
      OR "target_url" ~ '[[:space:][:cntrl:]]'
      OR length("target_url") > 2048
      OR "target_url" = '/admin' OR "target_url" LIKE '/admin/%'
      OR "target_url" = '/api' OR "target_url" LIKE '/api/%'
      OR "target_url" = '/go' OR "target_url" LIKE '/go/%'
      OR "target_url" = '/_next' OR "target_url" LIKE '/_next/%';

    UPDATE "ad_placements"
    SET
      "name" = "code",
      "position" = 'after_core_result',
      "width" = 970,
      "height" = 90;

    INSERT INTO "ad_placements_page_types" ("order", "parent_id", "value")
    SELECT 1, "id", 'tool' FROM "ad_placements";

    UPDATE "ad_schedules"
    SET
      "public_id" = gen_random_uuid()::text,
      "name" = 'Legacy schedule ' || "ad_schedules"."id",
      "advertiser_id" = "ad_creatives"."advertiser_id"
    FROM "ad_creatives"
    WHERE "ad_creatives"."id" = "ad_schedules"."creative_id";

    ALTER TABLE "ad_creatives" ALTER COLUMN "headline" SET NOT NULL;
    ALTER TABLE "ad_creatives" ALTER COLUMN "target_type" SET NOT NULL;
    ALTER TABLE "ad_creatives" ALTER COLUMN "image_id" DROP NOT NULL;
    ALTER TABLE "ad_creatives" ALTER COLUMN "alt" DROP NOT NULL;
    ALTER TABLE "ad_placements" ALTER COLUMN "name" SET NOT NULL;
    ALTER TABLE "ad_placements" ALTER COLUMN "position" SET NOT NULL;
    ALTER TABLE "ad_placements" ALTER COLUMN "width" SET NOT NULL;
    ALTER TABLE "ad_placements" ALTER COLUMN "height" SET NOT NULL;
    ALTER TABLE "ad_schedules" ALTER COLUMN "public_id" SET NOT NULL;
    ALTER TABLE "ad_schedules" ALTER COLUMN "name" SET NOT NULL;
    ALTER TABLE "ad_schedules" ALTER COLUMN "advertiser_id" SET NOT NULL;

    ALTER TABLE "ad_creatives" DROP CONSTRAINT "ad_creatives_image_id_media_id_fk";
    ALTER TABLE "advertisers_allowed_hosts" ADD CONSTRAINT "advertisers_allowed_hosts_parent_id_fk" FOREIGN KEY ("_parent_id") REFERENCES "public"."advertisers"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "ad_placements_page_types" ADD CONSTRAINT "ad_placements_page_types_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."ad_placements"("id") ON DELETE cascade ON UPDATE no action;
    ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_image_id_ad_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."ad_media"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "ad_schedules" ADD CONSTRAINT "ad_schedules_advertiser_id_advertisers_id_fk" FOREIGN KEY ("advertiser_id") REFERENCES "public"."advertisers"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_ad_media_fk" FOREIGN KEY ("ad_media_id") REFERENCES "public"."ad_media"("id") ON DELETE cascade ON UPDATE no action;

    CREATE INDEX "advertisers_allowed_hosts_order_idx" ON "advertisers_allowed_hosts" USING btree ("_order");
    CREATE INDEX "advertisers_allowed_hosts_parent_id_idx" ON "advertisers_allowed_hosts" USING btree ("_parent_id");
    CREATE INDEX "ad_media_reviewed_idx" ON "ad_media" USING btree ("reviewed");
    CREATE INDEX "ad_media_updated_at_idx" ON "ad_media" USING btree ("updated_at");
    CREATE INDEX "ad_media_created_at_idx" ON "ad_media" USING btree ("created_at");
    CREATE UNIQUE INDEX "ad_media_filename_idx" ON "ad_media" USING btree ("filename");
    CREATE INDEX "ad_placements_page_types_order_idx" ON "ad_placements_page_types" USING btree ("order");
    CREATE INDEX "ad_placements_page_types_parent_idx" ON "ad_placements_page_types" USING btree ("parent_id");
    CREATE INDEX "advertisers_status_idx" ON "advertisers" USING btree ("status");
    CREATE INDEX "ad_creatives_status_idx" ON "ad_creatives" USING btree ("status");
    CREATE INDEX "ad_placements_enabled_idx" ON "ad_placements" USING btree ("enabled");
    CREATE UNIQUE INDEX "ad_schedules_public_id_idx" ON "ad_schedules" USING btree ("public_id");
    CREATE INDEX "ad_schedules_advertiser_idx" ON "ad_schedules" USING btree ("advertiser_id");
    CREATE INDEX "ad_schedules_status_idx" ON "ad_schedules" USING btree ("status");
    CREATE INDEX "payload_locked_documents_rels_ad_media_id_idx" ON "payload_locked_documents_rels" USING btree ("ad_media_id");
  `)
}

export async function down({ db }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    ALTER TABLE "ad_creatives" DROP CONSTRAINT "ad_creatives_image_id_ad_media_id_fk";
    ALTER TABLE "ad_schedules" DROP CONSTRAINT "ad_schedules_advertiser_id_advertisers_id_fk";
    ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_ad_media_fk";

    INSERT INTO "media" (
      "alt", "source", "reviewed", "prefix", "updated_at", "created_at", "url",
      "thumbnail_u_r_l", "filename", "mime_type", "filesize", "width", "height", "focal_x", "focal_y"
    )
    SELECT
      ad_media."alt", ad_media."source", ad_media."reviewed", ad_media."prefix", ad_media."updated_at",
      ad_media."created_at", ad_media."url", ad_media."thumbnail_u_r_l", ad_media."filename",
      ad_media."mime_type", ad_media."filesize", ad_media."width", ad_media."height",
      ad_media."focal_x", ad_media."focal_y"
    FROM "ad_media"
    WHERE
      ad_media."filename" IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM "media" WHERE "media"."filename" = ad_media."filename");

    UPDATE "ad_creatives"
    SET "image_id" = "media"."id"
    FROM "ad_media", "media"
    WHERE
      "ad_creatives"."image_id" = "ad_media"."id"
      AND "ad_media"."filename" IS NOT NULL
      AND "media"."filename" = "ad_media"."filename";

    WITH placeholder AS (
      INSERT INTO "media" ("alt", "reviewed")
      SELECT '广告素材回滚占位图', false
      WHERE EXISTS (
        SELECT 1
        FROM "ad_creatives"
        WHERE
          "ad_creatives"."image_id" IS NULL
          OR EXISTS (
            SELECT 1
            FROM "ad_media"
            WHERE
              "ad_media"."id" = "ad_creatives"."image_id"
              AND (
                "ad_media"."filename" IS NULL
                OR NOT EXISTS (
                  SELECT 1 FROM "media" WHERE "media"."filename" = "ad_media"."filename"
                )
              )
          )
      )
      RETURNING "id"
    )
    UPDATE "ad_creatives"
    SET "image_id" = placeholder."id"
    FROM placeholder
    WHERE
      "ad_creatives"."image_id" IS NULL
      OR EXISTS (
        SELECT 1
        FROM "ad_media"
        WHERE
          "ad_media"."id" = "ad_creatives"."image_id"
          AND (
            "ad_media"."filename" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "media" WHERE "media"."filename" = "ad_media"."filename"
            )
          )
      );

    UPDATE "ad_creatives" SET "alt" = COALESCE(NULLIF("alt", ''), "name");
    UPDATE "advertisers" SET "status" = 'paused' WHERE "status" IN ('draft', 'disabled');
    UPDATE "ad_creatives" SET "status" = 'draft' WHERE "status" IN ('pending_review', 'rejected');
    UPDATE "ad_schedules" SET "status" = 'disabled' WHERE "status" IN ('draft', 'paused');

    DROP INDEX "advertisers_status_idx";
    DROP INDEX "ad_creatives_status_idx";
    DROP INDEX "ad_placements_enabled_idx";
    DROP INDEX "ad_schedules_public_id_idx";
    DROP INDEX "ad_schedules_advertiser_idx";
    DROP INDEX "ad_schedules_status_idx";
    DROP INDEX "payload_locked_documents_rels_ad_media_id_idx";

    ALTER TABLE "ad_creatives" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "ad_creatives" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
    DROP TYPE "public"."enum_ad_creatives_status";
    CREATE TYPE "public"."enum_ad_creatives_status" AS ENUM('draft', 'approved', 'disabled');
    ALTER TABLE "ad_creatives" ALTER COLUMN "status" SET DATA TYPE "public"."enum_ad_creatives_status" USING "status"::"public"."enum_ad_creatives_status";
    ALTER TABLE "ad_creatives" ALTER COLUMN "status" SET DEFAULT 'draft';

    ALTER TABLE "ad_schedules" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "ad_schedules" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
    DROP TYPE "public"."enum_ad_schedules_status";
    CREATE TYPE "public"."enum_ad_schedules_status" AS ENUM('scheduled', 'active', 'ended', 'disabled');
    ALTER TABLE "ad_schedules" ALTER COLUMN "status" SET DATA TYPE "public"."enum_ad_schedules_status" USING "status"::"public"."enum_ad_schedules_status";
    ALTER TABLE "ad_schedules" ALTER COLUMN "status" SET DEFAULT 'scheduled';

    ALTER TABLE "advertisers" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "advertisers" ALTER COLUMN "status" SET DATA TYPE text USING "status"::text;
    DROP TYPE "public"."enum_advertisers_status";
    CREATE TYPE "public"."enum_advertisers_status" AS ENUM('active', 'paused');
    ALTER TABLE "advertisers" ALTER COLUMN "status" SET DATA TYPE "public"."enum_advertisers_status" USING "status"::"public"."enum_advertisers_status";
    ALTER TABLE "advertisers" ALTER COLUMN "status" SET DEFAULT 'active';

    ALTER TABLE "ad_creatives" ALTER COLUMN "image_id" SET NOT NULL;
    ALTER TABLE "ad_creatives" ALTER COLUMN "alt" SET NOT NULL;
    ALTER TABLE "ad_placements" ALTER COLUMN "enabled" SET DEFAULT true;
    ALTER TABLE "ad_creatives" ADD CONSTRAINT "ad_creatives_image_id_media_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;

    DROP TABLE "advertisers_allowed_hosts" CASCADE;
    DROP TABLE "ad_placements_page_types" CASCADE;
    DROP TABLE "ad_media" CASCADE;

    ALTER TABLE "advertisers" DROP COLUMN "legal_name";
    ALTER TABLE "advertisers" DROP COLUMN "contact_name";
    ALTER TABLE "advertisers" DROP COLUMN "contact_email";
    ALTER TABLE "advertisers" DROP COLUMN "contract_reference";
    ALTER TABLE "ad_creatives" DROP COLUMN "creative_type";
    ALTER TABLE "ad_creatives" DROP COLUMN "headline";
    ALTER TABLE "ad_creatives" DROP COLUMN "body";
    ALTER TABLE "ad_creatives" DROP COLUMN "target_type";
    ALTER TABLE "ad_creatives" DROP COLUMN "review_notes";
    ALTER TABLE "ad_creatives" DROP COLUMN "reviewed_at";
    ALTER TABLE "ad_creatives" DROP COLUMN "reviewed_by";
    ALTER TABLE "ad_placements" DROP COLUMN "name";
    ALTER TABLE "ad_placements" DROP COLUMN "position";
    ALTER TABLE "ad_placements" DROP COLUMN "device_scope";
    ALTER TABLE "ad_placements" DROP COLUMN "width";
    ALTER TABLE "ad_placements" DROP COLUMN "height";
    ALTER TABLE "ad_schedules" DROP COLUMN "public_id";
    ALTER TABLE "ad_schedules" DROP COLUMN "name";
    ALTER TABLE "ad_schedules" DROP COLUMN "advertiser_id";
    ALTER TABLE "ad_schedules" DROP COLUMN "priority";
    ALTER TABLE "ad_schedules" DROP COLUMN "notes";
    ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "ad_media_id";

    DROP TYPE "public"."enum_ad_creatives_creative_type";
    DROP TYPE "public"."enum_ad_creatives_target_type";
    DROP TYPE "public"."enum_ad_placements_page_types";
    DROP TYPE "public"."enum_ad_placements_position";
    DROP TYPE "public"."enum_ad_placements_device_scope";
  `)
}
