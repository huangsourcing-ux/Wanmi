import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'
import { createCipheriv, createHmac, randomBytes } from 'node:crypto'

const LEGACY_PHONE_NORMALIZATION_REVIEW_REASON = 'd9a_legacy_phone_normalization_failed'
const LEGACY_PHONE_DUPLICATE_REVIEW_REASON = 'd9a_legacy_phone_duplicate'

function foldFullWidthAscii(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)
    if (codePoint === 0x3000) return ' '
    if (codePoint !== undefined && codePoint >= 0xff01 && codePoint <= 0xff5e) {
      return String.fromCodePoint(codePoint - 0xfee0)
    }
    return character
  }).join('')
}

function legacyPhone(value: string): string | undefined {
  const compact = foldFullWidthAscii(value).replace(/[\s()\p{Dash_Punctuation}]/gu, '')
  let nationalNumber = compact
  if (compact.startsWith('+86')) {
    nationalNumber = compact.slice(3)
  } else if (compact.startsWith('0086')) {
    nationalNumber = compact.slice(4)
  } else if (compact.startsWith('86')) {
    nationalNumber = compact.slice(2)
  }

  const normalized = `+86${nationalNumber}`
  return /^\+861[3-9]\d{9}$/u.test(normalized) ? normalized : undefined
}

function migrationIdentityKey(): Buffer {
  const encoded =
    process.env.CUSTOMER_IDENTITY_ENCRYPTION_KEY ?? process.env.TOTP_ENCRYPTION_KEY ?? ''
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64') !== encoded) {
    key.fill(0)
    throw new Error('D9-A migration identity encryption key is missing or invalid')
  }
  return key
}

function encryptLegacyIdentifier(value: string): string {
  const key = migrationIdentityKey()
  const iv = randomBytes(12)
  try {
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    return Buffer.from(
      JSON.stringify({
        ciphertext: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        version: 1,
      }),
    ).toString('base64url')
  } finally {
    key.fill(0)
  }
}

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  const pepper = process.env.SESSION_PEPPER
  if (!pepper) throw new Error('D9-A migration SESSION_PEPPER is missing')
  const validationKey = migrationIdentityKey()
  validationKey.fill(0)

  await db.execute(sql`
   CREATE TYPE "public"."enum_customers_account_type" AS ENUM('registered', 'legacy_unknown');
  CREATE TYPE "public"."enum_customers_registration_source" AS ENUM('phone', 'wechat_oauth', 'wechat_qrcode', 'legacy_unknown');
  CREATE TYPE "public"."enum_customers_default_customer_profile_type" AS ENUM('individual', 'organization');
  CREATE TYPE "public"."enum_customer_identities_provider" AS ENUM('phone', 'wechat');
  CREATE TYPE "public"."enum_customer_identities_status" AS ENUM('active', 'unbound');
  CREATE TYPE "public"."enum_consent_records_consent_type" AS ENUM('service_terms', 'privacy_policy', 'sensitive_personal_information', 'wechat_profile', 'commercial_sms', 'automatic_renewal', 'invitation_attribution', 'device_identifier_notice');
  CREATE TYPE "public"."enum_consent_records_source" AS ENUM('phone_registration', 'wechat_oauth_registration', 'wechat_qrcode_registration');
  CREATE TYPE "public"."enum_customer_registration_intents_provider" AS ENUM('phone', 'wechat');
  CREATE TYPE "public"."enum_customer_registration_intents_source" AS ENUM('phone', 'wechat_oauth', 'wechat_qrcode');
  CREATE TYPE "public"."enum_wechat_o_auth_states_purpose" AS ENUM('login', 'bind');
  CREATE TYPE "public"."enum_wechat_login_scenes_purpose" AS ENUM('login', 'bind');
  CREATE TYPE "public"."enum_wechat_login_scenes_status" AS ENUM('created', 'scanned', 'confirmed', 'consumed', 'rejected', 'expired');
  CREATE TABLE "customer_identities" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"provider" "enum_customer_identities_provider" NOT NULL,
  	"provider_instance_id" varchar NOT NULL,
  	"identifier_hash" varchar NOT NULL,
  	"identifier_encrypted" varchar NOT NULL,
  	"unionid" varchar,
  	"status" "enum_customer_identities_status" DEFAULT 'active' NOT NULL,
  	"verified_at" timestamp(3) with time zone NOT NULL,
  	"bound_at" timestamp(3) with time zone NOT NULL,
  	"unbound_at" timestamp(3) with time zone,
  	"last_used_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "consent_records" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"customer_id" integer NOT NULL,
  	"consent_type" "enum_consent_records_consent_type" NOT NULL,
  	"document_version" varchar NOT NULL,
  	"document_hash" varchar NOT NULL,
  	"accepted_at" timestamp(3) with time zone NOT NULL,
  	"revoked_at" timestamp(3) with time zone,
  	"source" "enum_consent_records_source" NOT NULL,
  	"ip_masked" varchar NOT NULL,
  	"user_agent_summary" varchar NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "customer_registration_intents" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"token_hash" varchar NOT NULL,
  	"provider" "enum_customer_registration_intents_provider" NOT NULL,
  	"provider_instance_id" varchar NOT NULL,
  	"identifier_hash" varchar NOT NULL,
  	"identifier_encrypted" varchar NOT NULL,
  	"phone_masked" varchar,
  	"source" "enum_customer_registration_intents_source" NOT NULL,
  	"device_hash" varchar NOT NULL,
  	"ip_hash" varchar NOT NULL,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"consumed_at" timestamp(3) with time zone,
  	"claimed_customer_id" integer,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "wechat_o_auth_states" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"state_hash" varchar NOT NULL,
  	"browser_session_hash" varchar NOT NULL,
  	"provider_instance_id" varchar NOT NULL,
  	"purpose" "enum_wechat_o_auth_states_purpose" NOT NULL,
  	"binding_customer_id" integer,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"consumed_at" timestamp(3) with time zone,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "wechat_authorization_codes" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"code_hash" varchar NOT NULL,
  	"processed_at" timestamp(3) with time zone NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  CREATE TABLE "wechat_login_scenes" (
  	"id" serial PRIMARY KEY NOT NULL,
  	"scene_hash" varchar NOT NULL,
  	"browser_session_hash" varchar NOT NULL,
  	"provider_instance_id" varchar NOT NULL,
  	"purpose" "enum_wechat_login_scenes_purpose" NOT NULL,
  	"binding_customer_id" integer,
  	"status" "enum_wechat_login_scenes_status" DEFAULT 'created' NOT NULL,
  	"device_summary" varchar NOT NULL,
  	"identifier_hash" varchar,
  	"identifier_encrypted" varchar,
  	"confirmation_token_hash" varchar,
  	"provider_ticket_hash" varchar,
  	"expires_at" timestamp(3) with time zone NOT NULL,
  	"scanned_at" timestamp(3) with time zone,
  	"confirmed_at" timestamp(3) with time zone,
  	"consumed_at" timestamp(3) with time zone,
  	"rejected_at" timestamp(3) with time zone,
  	"last_polled_at" timestamp(3) with time zone,
  	"poll_count" numeric DEFAULT 0 NOT NULL,
  	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
  	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL
  );
  
  ALTER TABLE "customers" ADD COLUMN "account_type" "enum_customers_account_type" DEFAULT 'legacy_unknown';
  ALTER TABLE "customers" ADD COLUMN "registration_source" "enum_customers_registration_source" DEFAULT 'legacy_unknown';
  ALTER TABLE "customers" ADD COLUMN "default_customer_profile_type" "enum_customers_default_customer_profile_type";
  ALTER TABLE "customers" ADD COLUMN "invite_code" varchar;
  ALTER TABLE "customers" ADD COLUMN "invited_by_customer_id" integer;
  ALTER TABLE "customers" ADD COLUMN "identity_risk_cooldown_started_at" timestamp(3) with time zone;
  ALTER TABLE "manual_reviews" ADD COLUMN "customer_id" integer;
  ALTER TABLE "manual_reviews" ADD COLUMN "customer_identity_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "customer_identities_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "consent_records_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "customer_registration_intents_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "wechat_o_auth_states_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "wechat_authorization_codes_id" integer;
  ALTER TABLE "payload_locked_documents_rels" ADD COLUMN "wechat_login_scenes_id" integer;
  ALTER TABLE "customer_identities" ADD CONSTRAINT "customer_identities_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "customer_registration_intents" ADD CONSTRAINT "customer_registration_intents_claimed_customer_id_customers_id_fk" FOREIGN KEY ("claimed_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wechat_o_auth_states" ADD CONSTRAINT "wechat_o_auth_states_binding_customer_id_customers_id_fk" FOREIGN KEY ("binding_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "wechat_login_scenes" ADD CONSTRAINT "wechat_login_scenes_binding_customer_id_customers_id_fk" FOREIGN KEY ("binding_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "customer_identities_customer_idx" ON "customer_identities" USING btree ("customer_id");
  CREATE INDEX "customer_identities_provider_idx" ON "customer_identities" USING btree ("provider");
  CREATE INDEX "customer_identities_provider_instance_id_idx" ON "customer_identities" USING btree ("provider_instance_id");
  CREATE INDEX "customer_identities_identifier_hash_idx" ON "customer_identities" USING btree ("identifier_hash");
  CREATE INDEX "customer_identities_status_idx" ON "customer_identities" USING btree ("status");
  CREATE INDEX "customer_identities_verified_at_idx" ON "customer_identities" USING btree ("verified_at");
  CREATE INDEX "customer_identities_bound_at_idx" ON "customer_identities" USING btree ("bound_at");
  CREATE INDEX "customer_identities_unbound_at_idx" ON "customer_identities" USING btree ("unbound_at");
  CREATE INDEX "customer_identities_last_used_at_idx" ON "customer_identities" USING btree ("last_used_at");
  CREATE INDEX "customer_identities_updated_at_idx" ON "customer_identities" USING btree ("updated_at");
  CREATE INDEX "customer_identities_created_at_idx" ON "customer_identities" USING btree ("created_at");
  CREATE UNIQUE INDEX "provider_providerInstanceId_identifierHash_idx" ON "customer_identities" USING btree ("provider","provider_instance_id","identifier_hash");
  CREATE INDEX "consent_records_customer_idx" ON "consent_records" USING btree ("customer_id");
  CREATE INDEX "consent_records_consent_type_idx" ON "consent_records" USING btree ("consent_type");
  CREATE INDEX "consent_records_accepted_at_idx" ON "consent_records" USING btree ("accepted_at");
  CREATE INDEX "consent_records_revoked_at_idx" ON "consent_records" USING btree ("revoked_at");
  CREATE INDEX "consent_records_updated_at_idx" ON "consent_records" USING btree ("updated_at");
  CREATE INDEX "consent_records_created_at_idx" ON "consent_records" USING btree ("created_at");
  CREATE INDEX "customer_consentType_acceptedAt_idx" ON "consent_records" USING btree ("customer_id","consent_type","accepted_at");
  CREATE UNIQUE INDEX "customer_registration_intents_token_hash_idx" ON "customer_registration_intents" USING btree ("token_hash");
  CREATE INDEX "customer_registration_intents_expires_at_idx" ON "customer_registration_intents" USING btree ("expires_at");
  CREATE INDEX "customer_registration_intents_consumed_at_idx" ON "customer_registration_intents" USING btree ("consumed_at");
  CREATE INDEX "customer_registration_intents_claimed_customer_idx" ON "customer_registration_intents" USING btree ("claimed_customer_id");
  CREATE INDEX "customer_registration_intents_updated_at_idx" ON "customer_registration_intents" USING btree ("updated_at");
  CREATE INDEX "customer_registration_intents_created_at_idx" ON "customer_registration_intents" USING btree ("created_at");
  CREATE INDEX "provider_providerInstanceId_identifierHash_1_idx" ON "customer_registration_intents" USING btree ("provider","provider_instance_id","identifier_hash");
  CREATE UNIQUE INDEX "wechat_o_auth_states_state_hash_idx" ON "wechat_o_auth_states" USING btree ("state_hash");
  CREATE INDEX "wechat_o_auth_states_binding_customer_idx" ON "wechat_o_auth_states" USING btree ("binding_customer_id");
  CREATE INDEX "wechat_o_auth_states_expires_at_idx" ON "wechat_o_auth_states" USING btree ("expires_at");
  CREATE INDEX "wechat_o_auth_states_consumed_at_idx" ON "wechat_o_auth_states" USING btree ("consumed_at");
  CREATE INDEX "wechat_o_auth_states_updated_at_idx" ON "wechat_o_auth_states" USING btree ("updated_at");
  CREATE INDEX "wechat_o_auth_states_created_at_idx" ON "wechat_o_auth_states" USING btree ("created_at");
  CREATE UNIQUE INDEX "wechat_authorization_codes_code_hash_idx" ON "wechat_authorization_codes" USING btree ("code_hash");
  CREATE INDEX "wechat_authorization_codes_processed_at_idx" ON "wechat_authorization_codes" USING btree ("processed_at");
  CREATE INDEX "wechat_authorization_codes_updated_at_idx" ON "wechat_authorization_codes" USING btree ("updated_at");
  CREATE INDEX "wechat_authorization_codes_created_at_idx" ON "wechat_authorization_codes" USING btree ("created_at");
  CREATE UNIQUE INDEX "wechat_login_scenes_scene_hash_idx" ON "wechat_login_scenes" USING btree ("scene_hash");
  CREATE INDEX "wechat_login_scenes_binding_customer_idx" ON "wechat_login_scenes" USING btree ("binding_customer_id");
  CREATE INDEX "wechat_login_scenes_status_idx" ON "wechat_login_scenes" USING btree ("status");
  CREATE UNIQUE INDEX "wechat_login_scenes_confirmation_token_hash_idx" ON "wechat_login_scenes" USING btree ("confirmation_token_hash");
  CREATE INDEX "wechat_login_scenes_expires_at_idx" ON "wechat_login_scenes" USING btree ("expires_at");
  CREATE INDEX "wechat_login_scenes_scanned_at_idx" ON "wechat_login_scenes" USING btree ("scanned_at");
  CREATE INDEX "wechat_login_scenes_confirmed_at_idx" ON "wechat_login_scenes" USING btree ("confirmed_at");
  CREATE INDEX "wechat_login_scenes_consumed_at_idx" ON "wechat_login_scenes" USING btree ("consumed_at");
  CREATE INDEX "wechat_login_scenes_rejected_at_idx" ON "wechat_login_scenes" USING btree ("rejected_at");
  CREATE INDEX "wechat_login_scenes_updated_at_idx" ON "wechat_login_scenes" USING btree ("updated_at");
  CREATE INDEX "wechat_login_scenes_created_at_idx" ON "wechat_login_scenes" USING btree ("created_at");
  ALTER TABLE "customers" ADD CONSTRAINT "customers_invited_by_customer_id_customers_id_fk" FOREIGN KEY ("invited_by_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_customer_identity_id_customer_identities_id_fk" FOREIGN KEY ("customer_identity_id") REFERENCES "public"."customer_identities"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_customer_identities_fk" FOREIGN KEY ("customer_identities_id") REFERENCES "public"."customer_identities"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_consent_records_fk" FOREIGN KEY ("consent_records_id") REFERENCES "public"."consent_records"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_customer_registration_inten_fk" FOREIGN KEY ("customer_registration_intents_id") REFERENCES "public"."customer_registration_intents"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_wechat_o_auth_states_fk" FOREIGN KEY ("wechat_o_auth_states_id") REFERENCES "public"."wechat_o_auth_states"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_wechat_authorization_codes_fk" FOREIGN KEY ("wechat_authorization_codes_id") REFERENCES "public"."wechat_authorization_codes"("id") ON DELETE cascade ON UPDATE no action;
  ALTER TABLE "payload_locked_documents_rels" ADD CONSTRAINT "payload_locked_documents_rels_wechat_login_scenes_fk" FOREIGN KEY ("wechat_login_scenes_id") REFERENCES "public"."wechat_login_scenes"("id") ON DELETE cascade ON UPDATE no action;
  CREATE INDEX "customers_account_type_idx" ON "customers" USING btree ("account_type");
  CREATE INDEX "customers_registration_source_idx" ON "customers" USING btree ("registration_source");
  CREATE INDEX "customers_default_customer_profile_type_idx" ON "customers" USING btree ("default_customer_profile_type");
  CREATE UNIQUE INDEX "customers_invite_code_idx" ON "customers" USING btree ("invite_code");
  CREATE INDEX "customers_invited_by_customer_idx" ON "customers" USING btree ("invited_by_customer_id");
  CREATE INDEX "customers_identity_risk_cooldown_started_at_idx" ON "customers" USING btree ("identity_risk_cooldown_started_at");
  CREATE INDEX "manual_reviews_customer_idx" ON "manual_reviews" USING btree ("customer_id");
  CREATE INDEX "manual_reviews_customer_identity_idx" ON "manual_reviews" USING btree ("customer_identity_id");
  CREATE INDEX "payload_locked_documents_rels_customer_identities_id_idx" ON "payload_locked_documents_rels" USING btree ("customer_identities_id");
  CREATE INDEX "payload_locked_documents_rels_consent_records_id_idx" ON "payload_locked_documents_rels" USING btree ("consent_records_id");
  CREATE INDEX "payload_locked_documents_rels_customer_registration_inte_idx" ON "payload_locked_documents_rels" USING btree ("customer_registration_intents_id");
  CREATE INDEX "payload_locked_documents_rels_wechat_o_auth_states_id_idx" ON "payload_locked_documents_rels" USING btree ("wechat_o_auth_states_id");
  CREATE INDEX "payload_locked_documents_rels_wechat_authorization_codes_idx" ON "payload_locked_documents_rels" USING btree ("wechat_authorization_codes_id");
  CREATE INDEX "payload_locked_documents_rels_wechat_login_scenes_id_idx" ON "payload_locked_documents_rels" USING btree ("wechat_login_scenes_id");`)

  const providerInstanceId = process.env.CUSTOMER_PHONE_IDENTITY_INSTANCE_ID || 'wanmi-sms-cn'
  const customers = await db.execute(sql`SELECT id, phone FROM customers ORDER BY id`)
  let identityConflictCount = 0
  let normalizationFailureCount = 0
  for (const row of customers.rows as Array<{ id: number; phone: string }>) {
    const phone = legacyPhone(row.phone)
    const inviteCode = createHmac('sha256', pepper)
      .update(`wanmi-invite:${row.id}`)
      .digest('hex')
      .slice(0, 12)
      .toUpperCase()
    await db.execute(sql`
      UPDATE customers
      SET
        account_type = 'legacy_unknown',
        registration_source = 'legacy_unknown',
        invite_code = COALESCE(invite_code, ${inviteCode}),
        updated_at = NOW()
      WHERE id = ${row.id}
    `)

    if (!phone) {
      await db.execute(sql`
        INSERT INTO manual_reviews (
          customer_id, reason_code, status, updated_at, created_at
        ) VALUES (
          ${row.id}, ${LEGACY_PHONE_NORMALIZATION_REVIEW_REASON}, 'open', NOW(), NOW()
        )
      `)
      normalizationFailureCount += 1
      continue
    }

    const identifierHash = createHmac('sha256', pepper).update(phone).digest('hex')
    const insertedIdentity = await db.execute(sql`
      INSERT INTO customer_identities (
        customer_id, provider, provider_instance_id, identifier_hash, identifier_encrypted,
        status, verified_at, bound_at, updated_at, created_at
      ) VALUES (
        ${row.id}, 'phone', ${providerInstanceId}, ${identifierHash},
        ${encryptLegacyIdentifier(phone)}, 'active', NOW(), NOW(), NOW(), NOW()
      )
      ON CONFLICT (provider, provider_instance_id, identifier_hash) DO NOTHING
      RETURNING id
    `)
    if (insertedIdentity.rows?.[0]?.id === undefined) {
      await db.execute(sql`
        INSERT INTO manual_reviews (
          customer_id, reason_code, status, updated_at, created_at
        ) VALUES (
          ${row.id}, ${LEGACY_PHONE_DUPLICATE_REVIEW_REASON}, 'open', NOW(), NOW()
        )
      `)
      identityConflictCount += 1
    }
  }

  payload.logger.info({
    identityConflictCount,
    msg: 'D9-A legacy phone migration completed',
    normalizationFailureCount,
  })
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
    DELETE FROM "manual_reviews"
    WHERE "reason_code" IN (
      ${LEGACY_PHONE_NORMALIZATION_REVIEW_REASON},
      ${LEGACY_PHONE_DUPLICATE_REVIEW_REASON}
    )
  `)

  await db.execute(sql`
   ALTER TABLE "customers" DROP CONSTRAINT "customers_invited_by_customer_id_customers_id_fk";
  
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_customer_id_customers_id_fk";
  
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_customer_identity_id_customer_identities_id_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_customer_identities_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_consent_records_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_customer_registration_inten_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_wechat_o_auth_states_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_wechat_authorization_codes_fk";
  
  ALTER TABLE "payload_locked_documents_rels" DROP CONSTRAINT "payload_locked_documents_rels_wechat_login_scenes_fk";

  ALTER TABLE "customer_identities" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "consent_records" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "customer_registration_intents" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "wechat_o_auth_states" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "wechat_authorization_codes" DISABLE ROW LEVEL SECURITY;
  ALTER TABLE "wechat_login_scenes" DISABLE ROW LEVEL SECURITY;
  DROP TABLE "customer_identities";
  DROP TABLE "consent_records";
  DROP TABLE "customer_registration_intents";
  DROP TABLE "wechat_o_auth_states";
  DROP TABLE "wechat_authorization_codes";
  DROP TABLE "wechat_login_scenes";
  
  DROP INDEX "customers_account_type_idx";
  DROP INDEX "customers_registration_source_idx";
  DROP INDEX "customers_default_customer_profile_type_idx";
  DROP INDEX "customers_invite_code_idx";
  DROP INDEX "customers_invited_by_customer_idx";
  DROP INDEX "customers_identity_risk_cooldown_started_at_idx";
  DROP INDEX "manual_reviews_customer_idx";
  DROP INDEX "manual_reviews_customer_identity_idx";
  DROP INDEX "payload_locked_documents_rels_customer_identities_id_idx";
  DROP INDEX "payload_locked_documents_rels_consent_records_id_idx";
  DROP INDEX "payload_locked_documents_rels_customer_registration_inte_idx";
  DROP INDEX "payload_locked_documents_rels_wechat_o_auth_states_id_idx";
  DROP INDEX "payload_locked_documents_rels_wechat_authorization_codes_idx";
  DROP INDEX "payload_locked_documents_rels_wechat_login_scenes_id_idx";
  ALTER TABLE "customers" DROP COLUMN "account_type";
  ALTER TABLE "customers" DROP COLUMN "registration_source";
  ALTER TABLE "customers" DROP COLUMN "default_customer_profile_type";
  ALTER TABLE "customers" DROP COLUMN "invite_code";
  ALTER TABLE "customers" DROP COLUMN "invited_by_customer_id";
  ALTER TABLE "customers" DROP COLUMN "identity_risk_cooldown_started_at";
  ALTER TABLE "manual_reviews" DROP COLUMN "customer_id";
  ALTER TABLE "manual_reviews" DROP COLUMN "customer_identity_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "customer_identities_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "consent_records_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "customer_registration_intents_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "wechat_o_auth_states_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "wechat_authorization_codes_id";
  ALTER TABLE "payload_locked_documents_rels" DROP COLUMN "wechat_login_scenes_id";
  DROP TYPE "public"."enum_customers_account_type";
  DROP TYPE "public"."enum_customers_registration_source";
  DROP TYPE "public"."enum_customers_default_customer_profile_type";
  DROP TYPE "public"."enum_customer_identities_provider";
  DROP TYPE "public"."enum_customer_identities_status";
  DROP TYPE "public"."enum_consent_records_consent_type";
  DROP TYPE "public"."enum_consent_records_source";
  DROP TYPE "public"."enum_customer_registration_intents_provider";
  DROP TYPE "public"."enum_customer_registration_intents_source";
  DROP TYPE "public"."enum_wechat_o_auth_states_purpose";
  DROP TYPE "public"."enum_wechat_login_scenes_purpose";
  DROP TYPE "public"."enum_wechat_login_scenes_status";`)
}
