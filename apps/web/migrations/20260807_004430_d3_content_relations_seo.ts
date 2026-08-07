import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TABLE "topics_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"tool_pages_id" integer,
  	"tld_pages_id" integer
  );
  
  CREATE TABLE "_topics_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"tool_pages_id" integer,
  	"tld_pages_id" integer
  );
  
  CREATE TABLE "tld_pages_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"tool_pages_id" integer
  );
  
  CREATE TABLE "_tld_pages_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"tool_pages_id" integer
  );
  
  CREATE TABLE "help_pages_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"tool_pages_id" integer,
  	"tld_pages_id" integer
  );
  
  CREATE TABLE "_help_pages_v_rels" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"tool_pages_id" integer,
  	"tld_pages_id" integer
  );
  
  CREATE TABLE "tool_pages" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"title" varchar NOT NULL,
  	"slug" varchar NOT NULL,
  	"href" varchar NOT NULL,
  	"description" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "articles_rels" ADD COLUMN "tool_pages_id" integer;
  ALTER TABLE "articles_rels" ADD COLUMN "tld_pages_id" integer;
  ALTER TABLE "_articles_v_rels" ADD COLUMN "tool_pages_id" integer;
  ALTER TABLE "_articles_v_rels" ADD COLUMN "tld_pages_id" integer;
  ALTER TABLE "help_pages" ADD COLUMN "meta_title" varchar;
  ALTER TABLE "help_pages" ADD COLUMN "meta_description" varchar;
  ALTER TABLE "help_pages" ADD COLUMN "meta_image_id" integer;
  ALTER TABLE "help_pages" ADD COLUMN "meta_canonical" varchar;
  ALTER TABLE "help_pages" ADD COLUMN "meta_no_index" boolean DEFAULT false;
  ALTER TABLE "_help_pages_v" ADD COLUMN "version_meta_title" varchar;
  ALTER TABLE "_help_pages_v" ADD COLUMN "version_meta_description" varchar;
  ALTER TABLE "_help_pages_v" ADD COLUMN "version_meta_image_id" integer;
  ALTER TABLE "_help_pages_v" ADD COLUMN "version_meta_canonical" varchar;
  ALTER TABLE "_help_pages_v" ADD COLUMN "version_meta_no_index" boolean DEFAULT false;
  ALTER TABLE "categories" ADD COLUMN "meta_title" varchar;
  ALTER TABLE "categories" ADD COLUMN "meta_description" varchar;
  ALTER TABLE "categories" ADD COLUMN "meta_image_id" integer;
  ALTER TABLE "categories" ADD COLUMN "meta_canonical" varchar;
  ALTER TABLE "categories" ADD COLUMN "meta_no_index" boolean DEFAULT false;
  ALTER TABLE "tags" ADD COLUMN "meta_title" varchar;
  ALTER TABLE "tags" ADD COLUMN "meta_description" varchar;
  ALTER TABLE "tags" ADD COLUMN "meta_image_id" integer;
  ALTER TABLE "tags" ADD COLUMN "meta_canonical" varchar;
  ALTER TABLE "tags" ADD COLUMN "meta_no_index" boolean DEFAULT false;
  ALTER TABLE "redirects_rels" ADD COLUMN "help_pages_id" integer;
  ALTER TABLE "redirects_rels" ADD COLUMN "categories_id" integer;
  ALTER TABLE "redirects_rels" ADD COLUMN "tags_id" integer;
  ALTER TABLE "redirects_rels" ADD COLUMN "tool_pages_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "tool_pages_id" integer;
  ALTER TABLE "topics_rels" ADD CONSTRAINT "topics_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."topics"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "topics_rels" ADD CONSTRAINT "topics_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "topics_rels" ADD CONSTRAINT "topics_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_topics_v_rels" ADD CONSTRAINT "_topics_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_topics_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_topics_v_rels" ADD CONSTRAINT "_topics_v_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_topics_v_rels" ADD CONSTRAINT "_topics_v_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tld_pages_rels" ADD CONSTRAINT "tld_pages_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "tld_pages_rels" ADD CONSTRAINT "tld_pages_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_tld_pages_v_rels" ADD CONSTRAINT "_tld_pages_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_tld_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_tld_pages_v_rels" ADD CONSTRAINT "_tld_pages_v_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "help_pages_rels" ADD CONSTRAINT "help_pages_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."help_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "help_pages_rels" ADD CONSTRAINT "help_pages_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "help_pages_rels" ADD CONSTRAINT "help_pages_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_help_pages_v_rels" ADD CONSTRAINT "_help_pages_v_rels_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."_help_pages_v"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_help_pages_v_rels" ADD CONSTRAINT "_help_pages_v_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_help_pages_v_rels" ADD CONSTRAINT "_help_pages_v_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "topics_rels_order_idx" ON "topics_rels" USING btree ("order");
  CREATE INDEX "topics_rels_parent_idx" ON "topics_rels" USING btree ("parent_id");
  CREATE INDEX "topics_rels_path_idx" ON "topics_rels" USING btree ("path");
  CREATE INDEX "topics_rels_tool_pages_id_idx" ON "topics_rels" USING btree ("tool_pages_id");
  CREATE INDEX "topics_rels_tld_pages_id_idx" ON "topics_rels" USING btree ("tld_pages_id");
  CREATE INDEX "_topics_v_rels_order_idx" ON "_topics_v_rels" USING btree ("order");
  CREATE INDEX "_topics_v_rels_parent_idx" ON "_topics_v_rels" USING btree ("parent_id");
  CREATE INDEX "_topics_v_rels_path_idx" ON "_topics_v_rels" USING btree ("path");
  CREATE INDEX "_topics_v_rels_tool_pages_id_idx" ON "_topics_v_rels" USING btree ("tool_pages_id");
  CREATE INDEX "_topics_v_rels_tld_pages_id_idx" ON "_topics_v_rels" USING btree ("tld_pages_id");
  CREATE INDEX "tld_pages_rels_order_idx" ON "tld_pages_rels" USING btree ("order");
  CREATE INDEX "tld_pages_rels_parent_idx" ON "tld_pages_rels" USING btree ("parent_id");
  CREATE INDEX "tld_pages_rels_path_idx" ON "tld_pages_rels" USING btree ("path");
  CREATE INDEX "tld_pages_rels_tool_pages_id_idx" ON "tld_pages_rels" USING btree ("tool_pages_id");
  CREATE INDEX "_tld_pages_v_rels_order_idx" ON "_tld_pages_v_rels" USING btree ("order");
  CREATE INDEX "_tld_pages_v_rels_parent_idx" ON "_tld_pages_v_rels" USING btree ("parent_id");
  CREATE INDEX "_tld_pages_v_rels_path_idx" ON "_tld_pages_v_rels" USING btree ("path");
  CREATE INDEX "_tld_pages_v_rels_tool_pages_id_idx" ON "_tld_pages_v_rels" USING btree ("tool_pages_id");
  CREATE INDEX "help_pages_rels_order_idx" ON "help_pages_rels" USING btree ("order");
  CREATE INDEX "help_pages_rels_parent_idx" ON "help_pages_rels" USING btree ("parent_id");
  CREATE INDEX "help_pages_rels_path_idx" ON "help_pages_rels" USING btree ("path");
  CREATE INDEX "help_pages_rels_tool_pages_id_idx" ON "help_pages_rels" USING btree ("tool_pages_id");
  CREATE INDEX "help_pages_rels_tld_pages_id_idx" ON "help_pages_rels" USING btree ("tld_pages_id");
  CREATE INDEX "_help_pages_v_rels_order_idx" ON "_help_pages_v_rels" USING btree ("order");
  CREATE INDEX "_help_pages_v_rels_parent_idx" ON "_help_pages_v_rels" USING btree ("parent_id");
  CREATE INDEX "_help_pages_v_rels_path_idx" ON "_help_pages_v_rels" USING btree ("path");
  CREATE INDEX "_help_pages_v_rels_tool_pages_id_idx" ON "_help_pages_v_rels" USING btree ("tool_pages_id");
  CREATE INDEX "_help_pages_v_rels_tld_pages_id_idx" ON "_help_pages_v_rels" USING btree ("tld_pages_id");
  CREATE UNIQUE INDEX "tool_pages_title_idx" ON "tool_pages" USING btree ("title");
  CREATE UNIQUE INDEX "tool_pages_slug_idx" ON "tool_pages" USING btree ("slug");
  CREATE UNIQUE INDEX "tool_pages_href_idx" ON "tool_pages" USING btree ("href");
  CREATE INDEX "tool_pages_updated_at_idx" ON "tool_pages" USING btree ("updated_at");
  CREATE INDEX "tool_pages_created_at_idx" ON "tool_pages" USING btree ("created_at");
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "articles_rels" ADD CONSTRAINT "articles_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "_articles_v_rels" ADD CONSTRAINT "_articles_v_rels_tld_pages_fk" FOREIGN KEY ("tld_pages_id") REFERENCES "public"."tld_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "help_pages" ADD CONSTRAINT "help_pages_meta_image_id_media_id_fk" FOREIGN KEY ("meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "_help_pages_v" ADD CONSTRAINT "_help_pages_v_version_meta_image_id_media_id_fk" FOREIGN KEY ("version_meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "categories" ADD CONSTRAINT "categories_meta_image_id_media_id_fk" FOREIGN KEY ("meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "tags" ADD CONSTRAINT "tags_meta_image_id_media_id_fk" FOREIGN KEY ("meta_image_id") REFERENCES "public"."media"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "redirects_rels" ADD CONSTRAINT "redirects_rels_help_pages_fk" FOREIGN KEY ("help_pages_id") REFERENCES "public"."help_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "redirects_rels" ADD CONSTRAINT "redirects_rels_categories_fk" FOREIGN KEY ("categories_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "redirects_rels" ADD CONSTRAINT "redirects_rels_tags_fk" FOREIGN KEY ("tags_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "redirects_rels" ADD CONSTRAINT "redirects_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_tool_pages_fk" FOREIGN KEY ("tool_pages_id") REFERENCES "public"."tool_pages"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "articles_rels_tool_pages_id_idx" ON "articles_rels" USING btree ("tool_pages_id");
  CREATE INDEX "articles_rels_tld_pages_id_idx" ON "articles_rels" USING btree ("tld_pages_id");
  CREATE INDEX "_articles_v_rels_tool_pages_id_idx" ON "_articles_v_rels" USING btree ("tool_pages_id");
  CREATE INDEX "_articles_v_rels_tld_pages_id_idx" ON "_articles_v_rels" USING btree ("tld_pages_id");
  CREATE INDEX "help_pages_meta_meta_image_idx" ON "help_pages" USING btree ("meta_image_id");
  CREATE INDEX "_help_pages_v_version_meta_version_meta_image_idx" ON "_help_pages_v" USING btree ("version_meta_image_id");
  CREATE INDEX "categories_meta_meta_image_idx" ON "categories" USING btree ("meta_image_id");
  CREATE INDEX "tags_meta_meta_image_idx" ON "tags" USING btree ("meta_image_id");
  CREATE INDEX "redirects_rels_help_pages_id_idx" ON "redirects_rels" USING btree ("help_pages_id");
  CREATE INDEX "redirects_rels_categories_id_idx" ON "redirects_rels" USING btree ("categories_id");
  CREATE INDEX "redirects_rels_tags_id_idx" ON "redirects_rels" USING btree ("tags_id");
  CREATE INDEX "redirects_rels_tool_pages_id_idx" ON "redirects_rels" USING btree ("tool_pages_id");
  CREATE INDEX "payload_locked_documents_rels_tool_pages_id_idx" ON "payload_locked_documents_rels" USING btree ("tool_pages_id");
  INSERT INTO "tool_pages" ("title", "slug", "href", "description", "updated_at", "created_at")
  VALUES
    ('域名可注册查询', 'domain-search', '/tools/domain-search', '输入完整域名或关键词，进入可注册与多后缀查询。', NOW(), NOW()),
    ('WHOIS / RDAP', 'whois', '/tools/whois', '查询公开注册信息，并明确区分注册信息与可购买状态。', NOW(), NOW()),
    ('DNS / NS 查询', 'dns', '/tools/dns', '查看常用 DNS 记录、Name Server 与可理解的错误说明。', NOW(), NOW()),
    ('SSL / CAA 检查', 'ssl-check', '/tools/ssl-check', '检查公开网站的 TLS 证书、有效期、域名匹配与 CAA。', NOW(), NOW()),
    ('IDN / Punycode', 'idn', '/tools/idn', '在 Unicode 中文域名与 ASCII Punycode 之间安全转换。', NOW(), NOW()),
    ('TLD 价格与成本', 'pricing', '/pricing', '比较 TLD 注册、续费、最低年限和 1 年 / 3 年成本。', NOW(), NOW());`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "topics_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_topics_v_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "tld_pages_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_tld_pages_v_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "help_pages_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "_help_pages_v_rels" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "tool_pages" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "topics_rels" CASCADE;
  DROP TABLE "_topics_v_rels" CASCADE;
  DROP TABLE "tld_pages_rels" CASCADE;
  DROP TABLE "_tld_pages_v_rels" CASCADE;
  DROP TABLE "help_pages_rels" CASCADE;
  DROP TABLE "_help_pages_v_rels" CASCADE;
  ALTER TABLE "articles_rels" DROP CONSTRAINT "articles_rels_tool_pages_fk";
  
  ALTER TABLE "articles_rels" DROP CONSTRAINT "articles_rels_tld_pages_fk";
  
  ALTER TABLE "_articles_v_rels" DROP CONSTRAINT "_articles_v_rels_tool_pages_fk";
  
  ALTER TABLE "_articles_v_rels" DROP CONSTRAINT "_articles_v_rels_tld_pages_fk";
  
  ALTER TABLE "help_pages" DROP CONSTRAINT "help_pages_meta_image_id_media_id_fk";
  
  ALTER TABLE "_help_pages_v" DROP CONSTRAINT "_help_pages_v_version_meta_image_id_media_id_fk";
  
  ALTER TABLE "categories" DROP CONSTRAINT "categories_meta_image_id_media_id_fk";
  
  ALTER TABLE "tags" DROP CONSTRAINT "tags_meta_image_id_media_id_fk";
  
  ALTER TABLE "redirects_rels" DROP CONSTRAINT "redirects_rels_help_pages_fk";
  
  ALTER TABLE "redirects_rels" DROP CONSTRAINT "redirects_rels_categories_fk";
  
  ALTER TABLE "redirects_rels" DROP CONSTRAINT "redirects_rels_tags_fk";
  
  ALTER TABLE "redirects_rels" DROP CONSTRAINT "redirects_rels_tool_pages_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_tool_pages_fk";
  
  DROP INDEX "articles_rels_tool_pages_id_idx";
  DROP INDEX "articles_rels_tld_pages_id_idx";
  DROP INDEX "_articles_v_rels_tool_pages_id_idx";
  DROP INDEX "_articles_v_rels_tld_pages_id_idx";
  DROP INDEX "help_pages_meta_meta_image_idx";
  DROP INDEX "_help_pages_v_version_meta_version_meta_image_idx";
  DROP INDEX "categories_meta_meta_image_idx";
  DROP INDEX "tags_meta_meta_image_idx";
  DROP INDEX "redirects_rels_help_pages_id_idx";
  DROP INDEX "redirects_rels_categories_id_idx";
  DROP INDEX "redirects_rels_tags_id_idx";
  DROP INDEX "redirects_rels_tool_pages_id_idx";
  DROP INDEX "payload_locked_documents_rels_tool_pages_id_idx";
  ALTER TABLE "articles_rels" DROP COLUMN "tool_pages_id";
  ALTER TABLE "articles_rels" DROP COLUMN "tld_pages_id";
  ALTER TABLE "_articles_v_rels" DROP COLUMN "tool_pages_id";
  ALTER TABLE "_articles_v_rels" DROP COLUMN "tld_pages_id";
  ALTER TABLE "help_pages" DROP COLUMN "meta_title";
  ALTER TABLE "help_pages" DROP COLUMN "meta_description";
  ALTER TABLE "help_pages" DROP COLUMN "meta_image_id";
  ALTER TABLE "help_pages" DROP COLUMN "meta_canonical";
  ALTER TABLE "help_pages" DROP COLUMN "meta_no_index";
  ALTER TABLE "_help_pages_v" DROP COLUMN "version_meta_title";
  ALTER TABLE "_help_pages_v" DROP COLUMN "version_meta_description";
  ALTER TABLE "_help_pages_v" DROP COLUMN "version_meta_image_id";
  ALTER TABLE "_help_pages_v" DROP COLUMN "version_meta_canonical";
  ALTER TABLE "_help_pages_v" DROP COLUMN "version_meta_no_index";
  ALTER TABLE "categories" DROP COLUMN "meta_title";
  ALTER TABLE "categories" DROP COLUMN "meta_description";
  ALTER TABLE "categories" DROP COLUMN "meta_image_id";
  ALTER TABLE "categories" DROP COLUMN "meta_canonical";
  ALTER TABLE "categories" DROP COLUMN "meta_no_index";
  ALTER TABLE "tags" DROP COLUMN "meta_title";
  ALTER TABLE "tags" DROP COLUMN "meta_description";
  ALTER TABLE "tags" DROP COLUMN "meta_image_id";
  ALTER TABLE "tags" DROP COLUMN "meta_canonical";
  ALTER TABLE "tags" DROP COLUMN "meta_no_index";
  ALTER TABLE "redirects_rels" DROP COLUMN "help_pages_id";
  ALTER TABLE "redirects_rels" DROP COLUMN "categories_id";
  ALTER TABLE "redirects_rels" DROP COLUMN "tags_id";
  ALTER TABLE "redirects_rels" DROP COLUMN "tool_pages_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "tool_pages_id";
  DROP TABLE "tool_pages" CASCADE;`)
}
