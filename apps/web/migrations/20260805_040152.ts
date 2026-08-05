import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   CREATE TYPE "public"."enum_admins_status" AS ENUM('active', 'disabled');
  CREATE TYPE "public"."enum_admin_invitations_roles" AS ENUM('content_editor', 'ad_operator', 'analyst', 'system_admin');
  CREATE TYPE "public"."enum_admin_invitations_purpose" AS ENUM('new_admin', 'mfa_reset');
  CREATE TABLE "admin_mfa_credentials" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"admin_id" integer NOT NULL,
  	"secret_encrypted" varchar NOT NULL,
  	"last_used_step" numeric,
  	"failed_attempts" numeric DEFAULT 0 NOT NULL,
  	"locked_until" timestamp(3) with time zone,
  	"version" numeric DEFAULT 0 NOT NULL,
  	"configured_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "admin_mfa_credentials_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  CREATE TABLE "admin_invitations_roles" (
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"value" "enum_admin_invitations_roles",
  	"id" serial PRIMARY KEY NOT NULL
  );
  
  CREATE TABLE "admin_invitations" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"purpose" "enum_admin_invitations_purpose" NOT NULL,
  	"email" varchar NOT NULL,
  	"target_admin_id" integer,
  	"token_hash" varchar NOT NULL,
  	"totp_secret_encrypted" varchar NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"consumed_at" timestamp(3) with time zone,
  	"revoked_at" timestamp(3) with time zone,
  	"created_by_id" integer NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "admins" ADD COLUMN "status" "enum_admins_status" DEFAULT 'active' NOT NULL;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "admin_mfa_credentials_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "admin_invitations_id" integer;
  ALTER TABLE "admin_mfa_credentials" ADD CONSTRAINT "admin_mfa_credentials_admin_id_admins_id_fk" FOREIGN KEY ("admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "admin_mfa_credentials_texts" ADD CONSTRAINT "admin_mfa_credentials_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."admin_mfa_credentials"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "admin_invitations_roles" ADD CONSTRAINT "admin_invitations_roles_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."admin_invitations"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_target_admin_id_admins_id_fk" FOREIGN KEY ("target_admin_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "admin_invitations" ADD CONSTRAINT "admin_invitations_created_by_id_admins_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."admins"("id") ON DELETE set null ON UPDATE no action;
  CREATE UNIQUE INDEX "admin_mfa_credentials_admin_idx" ON "admin_mfa_credentials" USING btree ("admin_id");
  CREATE INDEX "admin_mfa_credentials_locked_until_idx" ON "admin_mfa_credentials" USING btree ("locked_until");
  CREATE INDEX "admin_mfa_credentials_updated_at_idx" ON "admin_mfa_credentials" USING btree ("updated_at");
  CREATE INDEX "admin_mfa_credentials_created_at_idx" ON "admin_mfa_credentials" USING btree ("created_at");
  CREATE INDEX "admin_mfa_credentials_texts_order_parent" ON "admin_mfa_credentials_texts" USING btree ("order","parent_id");
  CREATE INDEX "admin_invitations_roles_order_idx" ON "admin_invitations_roles" USING btree ("order");
  CREATE INDEX "admin_invitations_roles_parent_idx" ON "admin_invitations_roles" USING btree ("parent_id");
  CREATE INDEX "admin_invitations_email_idx" ON "admin_invitations" USING btree ("email");
  CREATE INDEX "admin_invitations_target_admin_idx" ON "admin_invitations" USING btree ("target_admin_id");
  CREATE UNIQUE INDEX "admin_invitations_token_hash_idx" ON "admin_invitations" USING btree ("token_hash");
  CREATE INDEX "admin_invitations_expires_at_idx" ON "admin_invitations" USING btree ("expires_at");
  CREATE INDEX "admin_invitations_consumed_at_idx" ON "admin_invitations" USING btree ("consumed_at");
  CREATE INDEX "admin_invitations_revoked_at_idx" ON "admin_invitations" USING btree ("revoked_at");
  CREATE INDEX "admin_invitations_created_by_idx" ON "admin_invitations" USING btree ("created_by_id");
  CREATE INDEX "admin_invitations_updated_at_idx" ON "admin_invitations" USING btree ("updated_at");
  CREATE INDEX "admin_invitations_created_at_idx" ON "admin_invitations" USING btree ("created_at");
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_admin_mfa_credentials_fk" FOREIGN KEY ("admin_mfa_credentials_id") REFERENCES "public"."admin_mfa_credentials"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_admin_invitations_fk" FOREIGN KEY ("admin_invitations_id") REFERENCES "public"."admin_invitations"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "payload_locked_documents_rels_admin_mfa_credentials_id_idx" ON "payload_locked_documents_rels" USING btree ("admin_mfa_credentials_id");
  CREATE INDEX "payload_locked_documents_rels_admin_invitations_id_idx" ON "payload_locked_documents_rels" USING btree ("admin_invitations_id");

  INSERT INTO "admin_mfa_credentials" (
    "admin_id", "secret_encrypted", "last_used_step", "failed_attempts", "version",
    "configured_at", "updated_at", "created_at"
  )
  SELECT
    "id", "totp_secret_encrypted", "totp_last_used_step", 0, 0,
    COALESCE("updated_at", "created_at"), "updated_at", "created_at"
  FROM "admins"
  WHERE "totp_enabled" = true AND "totp_secret_encrypted" IS NOT NULL;

  INSERT INTO "admin_mfa_credentials_texts" ("order", "parent_id", "path", "text")
  SELECT legacy."order", credentials."id", 'recoveryCodeHashes', legacy."text"
  FROM "admins_texts" legacy
  JOIN "admin_mfa_credentials" credentials ON credentials."admin_id" = legacy."parent_id"
  WHERE legacy."path" = 'recoveryCodeHashes';

  CREATE OR REPLACE FUNCTION "wanmi_require_active_system_admin"() RETURNS trigger
  LANGUAGE plpgsql AS $$
  BEGIN
    PERFORM pg_advisory_xact_lock(9182041505);
    IF NOT EXISTS (
      SELECT 1
      FROM "admins" admin_account
      JOIN "admins_roles" admin_role ON admin_role."parent_id" = admin_account."id"
      WHERE admin_account."status" = 'active' AND admin_role."value" = 'system_admin'
    ) THEN
      RAISE EXCEPTION 'LAST_SYSTEM_ADMIN_PROTECTED' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END;
  $$;

  CREATE CONSTRAINT TRIGGER "admins_require_active_system_admin"
  AFTER INSERT OR UPDATE OR DELETE ON "admins"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "wanmi_require_active_system_admin"();

  CREATE CONSTRAINT TRIGGER "admins_roles_require_active_system_admin"
  AFTER INSERT OR UPDATE OR DELETE ON "admins_roles"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "wanmi_require_active_system_admin"();

  ALTER TABLE "admins_texts" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "admins_texts" CASCADE;
  ALTER TABLE "admins" DROP COLUMN "totp_secret_encrypted";
  ALTER TABLE "admins" DROP COLUMN "totp_enabled";
  ALTER TABLE "admins" DROP COLUMN "totp_last_used_step";`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   DROP TRIGGER IF EXISTS "admins_require_active_system_admin" ON "admins";
  DROP TRIGGER IF EXISTS "admins_roles_require_active_system_admin" ON "admins_roles";
  DROP FUNCTION IF EXISTS "wanmi_require_active_system_admin"();

   CREATE TABLE "admins_texts" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"order" integer NOT NULL,
  	"parent_id" integer NOT NULL,
  	"path" varchar NOT NULL,
  	"text" varchar
  );
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_admin_mfa_credentials_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_admin_invitations_fk";
  
  DROP INDEX "payload_locked_documents_rels_admin_mfa_credentials_id_idx";
  DROP INDEX "payload_locked_documents_rels_admin_invitations_id_idx";
  ALTER TABLE "admins" ADD COLUMN "totp_secret_encrypted" varchar;
  ALTER TABLE "admins" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;
  ALTER TABLE "admins" ADD COLUMN "totp_last_used_step" numeric;
  ALTER TABLE "admins_texts" ADD CONSTRAINT "admins_texts_parent_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."admins"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "admins_texts_order_parent" ON "admins_texts" USING btree ("order","parent_id");

  UPDATE "admins" admin_account
  SET
    "totp_secret_encrypted" = credentials."secret_encrypted",
    "totp_enabled" = true,
    "totp_last_used_step" = credentials."last_used_step"
  FROM "admin_mfa_credentials" credentials
  WHERE credentials."admin_id" = admin_account."id";

  INSERT INTO "admins_texts" ("order", "parent_id", "path", "text")
  SELECT hashes."order", credentials."admin_id", 'recoveryCodeHashes', hashes."text"
  FROM "admin_mfa_credentials_texts" hashes
  JOIN "admin_mfa_credentials" credentials ON credentials."id" = hashes."parent_id"
  WHERE hashes."path" = 'recoveryCodeHashes';

  ALTER TABLE "admin_mfa_credentials" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "admin_mfa_credentials_texts" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "admin_invitations_roles" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "admin_invitations" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "admin_mfa_credentials" CASCADE;
  DROP TABLE "admin_mfa_credentials_texts" CASCADE;
  DROP TABLE "admin_invitations_roles" CASCADE;
  DROP TABLE "admin_invitations" CASCADE;
  ALTER TABLE "admins" DROP COLUMN "status";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "admin_mfa_credentials_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "admin_invitations_id";
  DROP TYPE "public"."enum_admins_status";
  DROP TYPE "public"."enum_admin_invitations_roles";
  DROP TYPE "public"."enum_admin_invitations_purpose";`)
}
