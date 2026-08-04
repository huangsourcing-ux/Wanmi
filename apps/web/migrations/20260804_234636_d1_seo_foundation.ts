import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles" ADD COLUMN "meta_canonical" varchar;
  ALTER TABLE "articles" ADD COLUMN "meta_no_index" boolean DEFAULT false;
  ALTER TABLE "_articles_v" ADD COLUMN "version_meta_canonical" varchar;
  ALTER TABLE "_articles_v" ADD COLUMN "version_meta_no_index" boolean DEFAULT false;
  ALTER TABLE "topics" ADD COLUMN "meta_canonical" varchar;
  ALTER TABLE "topics" ADD COLUMN "meta_no_index" boolean DEFAULT false;
  ALTER TABLE "_topics_v" ADD COLUMN "version_meta_canonical" varchar;
  ALTER TABLE "_topics_v" ADD COLUMN "version_meta_no_index" boolean DEFAULT false;
  ALTER TABLE "tld_pages" ADD COLUMN "meta_canonical" varchar;
  ALTER TABLE "tld_pages" ADD COLUMN "meta_no_index" boolean DEFAULT false;
  ALTER TABLE "_tld_pages_v" ADD COLUMN "version_meta_canonical" varchar;
  ALTER TABLE "_tld_pages_v" ADD COLUMN "version_meta_no_index" boolean DEFAULT false;`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "articles" DROP COLUMN "meta_canonical";
  ALTER TABLE "articles" DROP COLUMN "meta_no_index";
  ALTER TABLE "_articles_v" DROP COLUMN "version_meta_canonical";
  ALTER TABLE "_articles_v" DROP COLUMN "version_meta_no_index";
  ALTER TABLE "topics" DROP COLUMN "meta_canonical";
  ALTER TABLE "topics" DROP COLUMN "meta_no_index";
  ALTER TABLE "_topics_v" DROP COLUMN "version_meta_canonical";
  ALTER TABLE "_topics_v" DROP COLUMN "version_meta_no_index";
  ALTER TABLE "tld_pages" DROP COLUMN "meta_canonical";
  ALTER TABLE "tld_pages" DROP COLUMN "meta_no_index";
  ALTER TABLE "_tld_pages_v" DROP COLUMN "version_meta_canonical";
  ALTER TABLE "_tld_pages_v" DROP COLUMN "version_meta_no_index";`)
}
