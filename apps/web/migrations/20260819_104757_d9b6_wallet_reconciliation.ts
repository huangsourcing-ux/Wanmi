import { MigrateUpArgs, MigrateDownArgs, sql } from '@payloadcms/db-postgres'

export async function up({ db, payload, req }: MigrateUpArgs): Promise<void> {
  await db.execute(sql`
   ALTER TYPE "public"."enum_reconciliations_kind" ADD VALUE 'wallet';
  ALTER TYPE "public"."enum_reconciliations_ledger" ADD VALUE 'wallet_balance';
  ALTER TABLE "wallet_accounts" ADD COLUMN "posted_balance_cache_fen" numeric DEFAULT 0 NOT NULL;
  ALTER TABLE "wallet_accounts" ADD COLUMN "held_balance_cache_fen" numeric DEFAULT 0 NOT NULL;
  UPDATE wallet_accounts account
  SET
    posted_balance_cache_fen = COALESCE((
      SELECT SUM(
        CASE
          WHEN entry_type = 'credit' THEN amount_fen
          WHEN entry_type IN ('capture', 'recovery') THEN -amount_fen
          ELSE 0
        END
      )
      FROM wallet_entries
      WHERE account_id = account.id
    ), 0),
    held_balance_cache_fen = COALESCE((
      SELECT SUM(
        CASE
          WHEN entry_type = 'hold' THEN amount_fen
          WHEN entry_type IN ('capture', 'release') THEN -amount_fen
          ELSE 0
        END
      )
      FROM wallet_entries
      WHERE account_id = account.id
    ), 0);
  ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_posted_balance_cache_safe_integer" CHECK (
    posted_balance_cache_fen = trunc(posted_balance_cache_fen)
    AND posted_balance_cache_fen BETWEEN -9007199254740991 AND 9007199254740991
  );
  ALTER TABLE "wallet_accounts" ADD CONSTRAINT "wallet_accounts_held_balance_cache_safe_integer" CHECK (
    held_balance_cache_fen = trunc(held_balance_cache_fen)
    AND held_balance_cache_fen BETWEEN 0 AND 9007199254740991
  );
  ALTER TABLE "manual_reviews" ADD COLUMN "wallet_account_id" integer;
  ALTER TABLE "manual_reviews" ADD COLUMN "reconciliation_id" integer;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_wallet_account_id_wallet_accounts_id_fk" FOREIGN KEY ("wallet_account_id") REFERENCES "public"."wallet_accounts"("id") ON DELETE set null ON UPDATE no action;
  ALTER TABLE "manual_reviews" ADD CONSTRAINT "manual_reviews_reconciliation_id_reconciliations_id_fk" FOREIGN KEY ("reconciliation_id") REFERENCES "public"."reconciliations"("id") ON DELETE set null ON UPDATE no action;
  CREATE INDEX "manual_reviews_wallet_account_idx" ON "manual_reviews" USING btree ("wallet_account_id");
  CREATE UNIQUE INDEX "manual_reviews_reconciliation_idx" ON "manual_reviews" USING btree ("reconciliation_id");`)
}

export async function down({ db, payload, req }: MigrateDownArgs): Promise<void> {
  await db.execute(sql`
   ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_wallet_account_id_wallet_accounts_id_fk";
  
  ALTER TABLE "manual_reviews" DROP CONSTRAINT "manual_reviews_reconciliation_id_reconciliations_id_fk";
  
  ALTER TABLE "reconciliations" ALTER COLUMN "kind" SET DATA TYPE text;
  DROP TYPE "public"."enum_reconciliations_kind";
  CREATE TYPE "public"."enum_reconciliations_kind" AS ENUM('wechat', 'westdigital', 'three_way');
  ALTER TABLE "reconciliations" ALTER COLUMN "kind" SET DATA TYPE "public"."enum_reconciliations_kind" USING "kind"::"public"."enum_reconciliations_kind";
  ALTER TABLE "reconciliations" ALTER COLUMN "ledger" SET DATA TYPE text;
  DROP TYPE "public"."enum_reconciliations_ledger";
  CREATE TYPE "public"."enum_reconciliations_ledger" AS ENUM('wechat_funds', 'westdigital_prepaid', 'internal_orders');
  ALTER TABLE "reconciliations" ALTER COLUMN "ledger" SET DATA TYPE "public"."enum_reconciliations_ledger" USING "ledger"::"public"."enum_reconciliations_ledger";
  DROP INDEX "manual_reviews_wallet_account_idx";
  DROP INDEX "manual_reviews_reconciliation_idx";
  ALTER TABLE "wallet_accounts" DROP CONSTRAINT "wallet_accounts_posted_balance_cache_safe_integer";
  ALTER TABLE "wallet_accounts" DROP CONSTRAINT "wallet_accounts_held_balance_cache_safe_integer";
  ALTER TABLE "wallet_accounts" DROP COLUMN "posted_balance_cache_fen";
  ALTER TABLE "wallet_accounts" DROP COLUMN "held_balance_cache_fen";
  ALTER TABLE "manual_reviews" DROP COLUMN "wallet_account_id";
  ALTER TABLE "manual_reviews" DROP COLUMN "reconciliation_id";`)
}
