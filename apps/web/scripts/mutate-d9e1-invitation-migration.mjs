import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url))
const verifier = 'scripts/verify-d9e1-invitations-migration.mjs'
const migrationPath = 'apps/web/migrations/20260820_051725_d9e1_invitations_abuse.ts'
const releasePolicyPath = 'deploy/release-policy.json'
const releaseManifestPath = 'deploy/release-manifest.example.json'
const migrationSource = readFileSync(`${repositoryRoot}/${migrationPath}`, 'utf8')
const releasePolicy = readFileSync(`${repositoryRoot}/${releasePolicyPath}`, 'utf8')
const releaseManifest = readFileSync(`${repositoryRoot}/${releaseManifestPath}`, 'utf8')
const mutations = []

function occurrences(source, search) {
  return source.split(search).length - 1
}

function replaceOccurrence(source, search, replacement, occurrence = 1) {
  let seen = 0
  return source.replaceAll(search, (match) => {
    seen += 1
    return seen === occurrence ? replacement : match
  })
}

function exactMutation({ expectedOccurrences = 1, occurrence = 1, ...mutation }) {
  mutations.push({
    ...mutation,
    transform(source) {
      const found = occurrences(source, mutation.search)
      if (found !== expectedOccurrences) {
        throw new Error(`expected ${expectedOccurrences} occurrences, found ${found}`)
      }
      return replaceOccurrence(source, mutation.search, mutation.replacement, occurrence)
    },
  })
}

function jsonMutation(mutation) {
  mutations.push({
    ...mutation,
    transform(source) {
      const document = JSON.parse(source)
      mutation.mutate(document)
      return JSON.stringify(document)
    },
  })
}

for (const mutation of [
  {
    id: 'release-phase',
    field: 'phase',
    value: 'contract',
  },
  {
    id: 'release-new-code-compatibility',
    field: 'newCodeCompatibleBeforeUp',
    value: false,
  },
  {
    id: 'release-old-code-compatibility',
    field: 'oldCodeCompatible',
    value: false,
  },
  {
    id: 'release-rollback-policy',
    field: 'rollback',
    value: 'reverse',
  },
]) {
  jsonMutation({
    file: releasePolicyPath,
    group: 'release',
    id: mutation.id,
    input: 'D9E1_RELEASE_POLICY_BASE64',
    source: releasePolicy,
    mutate(document) {
      document.migrations['20260820_051725_d9e1_invitations_abuse'][mutation.field] = mutation.value
    },
  })
}

jsonMutation({
  file: releaseManifestPath,
  group: 'release',
  id: 'release-manifest-entry',
  input: 'D9E1_RELEASE_MANIFEST_BASE64',
  source: releaseManifest,
  mutate(document) {
    document.migrations = document.migrations.filter(
      (name) => name !== '20260820_051725_d9e1_invitations_abuse',
    )
  },
})

for (const mutation of [
  {
    group: 'enum',
    id: 'points-source-enum',
    search: `  ALTER TYPE "public"."enum_points_batches_source_type" ADD VALUE 'invitation_reward';\n`,
    replacement: '',
  },
  {
    group: 'enum',
    id: 'notification-type-enum',
    search: `  ALTER TYPE "public"."enum_notification_outbox_events_notification_type" ADD VALUE 'invitation_reward_withheld' BEFORE 'product_updates';\n`,
    replacement: '',
  },
  {
    group: 'notification',
    id: 'transactional-alert-category',
    search: `    ("category" = 'transactional' AND "notification_type"::text IN (\n`,
    replacement: `    (true OR "category" = 'transactional' AND "notification_type"::text IN (\n`,
  },
  {
    group: 'points-source',
    id: 'points-source-customer-backfill',
    search:
      '  UPDATE "points_batches" SET "source_customer_id" = "customer_id" WHERE "source_customer_id" IS NULL;\n',
    replacement:
      '  UPDATE "points_batches" SET "source_customer_id" = 1 WHERE "source_customer_id" IS NULL;\n',
  },
  {
    group: 'points-source',
    id: 'invitation-points-source-customer-required',
    search: `  ALTER TABLE "points_batches" ADD CONSTRAINT "points_batches_invitation_source_customer_required" CHECK (\n    "source_type"::text <> 'invitation_reward' OR "source_customer_id" IS NOT NULL\n  );\n`,
    replacement: '',
  },
  {
    group: 'points-source',
    id: 'points-source-customer-foreign-key',
    search:
      '  ALTER TABLE "points_batches" ADD CONSTRAINT "points_batches_source_customer_id_customers_id_fk" FOREIGN KEY ("source_customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;\n',
    replacement: '',
  },
  {
    group: 'legacy',
    id: 'legacy-relationship-backfill-source',
    search: '    WHERE invitee.invited_by_customer_id IS NOT NULL\n',
    replacement: '    WHERE false\n',
  },
  {
    group: 'rules',
    id: 'rule-version-unique',
    search:
      '  CREATE UNIQUE INDEX "version_idx" ON "invitation_reward_rule_versions" USING btree ("version");\n',
    replacement: '',
  },
  {
    group: 'rules',
    id: 'rule-points-integral',
    search:
      '      "reward_points" = trunc("reward_points") AND "reward_points" BETWEEN 1 AND 9007199254740991 AND\n',
    replacement: '      "reward_points" BETWEEN 0 AND 9007199254740991 AND\n',
  },
  {
    group: 'rules',
    id: 'rule-window-limit',
    search:
      '      "binding_window_hours" = trunc("binding_window_hours") AND "binding_window_hours" BETWEEN 1 AND 720 AND\n',
    replacement: '      "binding_window_hours" >= 1 AND\n',
  },
  {
    group: 'relationships',
    id: 'relationship-not-self',
    search: '      "inviter_customer_id" <> "invitee_customer_id" AND\n',
    replacement: '      true AND\n',
    expectedOccurrences: 3,
    occurrence: 1,
  },
  {
    group: 'relationships',
    id: 'relationship-window-order',
    search: '      "binding_window_ends_at" >= "bound_at"\n',
    replacement: '      true\n',
  },
  {
    group: 'relationships',
    id: 'relationship-key-unique',
    search:
      '  CREATE UNIQUE INDEX "invitation_relationships_relationship_key_idx" ON "invitation_relationships" USING btree ("relationship_key");\n',
    replacement: '',
  },
  {
    group: 'relationships',
    id: 'relationship-invitee-unique',
    search: '    ON CONFLICT (invitee_customer_id) DO NOTHING;\n',
    replacement:
      '    ON CONFLICT (invitee_customer_id) DO NOTHING;\n    DROP INDEX "inviteeCustomer_idx";\n',
  },
  {
    group: 'claims',
    id: 'claim-not-self',
    search: '      "inviter_customer_id" <> "invitee_customer_id" AND\n',
    replacement: '      true AND\n',
    expectedOccurrences: 3,
    occurrence: 2,
  },
  {
    group: 'claims',
    id: 'claim-points-integral',
    search: '      "points" = trunc("points") AND "points" BETWEEN 1 AND 9007199254740991 AND\n',
    replacement: '      "points" BETWEEN 0 AND 9007199254740991 AND\n',
  },
  {
    group: 'claims',
    id: 'claim-expiry-order',
    search: '      "expires_at" > "created_at"\n',
    replacement: '      true\n',
  },
  {
    group: 'claims',
    id: 'claim-key-unique',
    search:
      '  CREATE UNIQUE INDEX "invitation_reward_claims_claim_key_idx" ON "invitation_reward_claims" USING btree ("claim_key");\n',
    replacement: '',
  },
  {
    group: 'claims',
    id: 'claim-relationship-unique',
    search:
      '  CREATE UNIQUE INDEX "invitation_reward_claims_relationship_idx" ON "invitation_reward_claims" USING btree ("relationship_id");\n',
    replacement: '',
  },
  {
    group: 'claims',
    id: 'claim-invitee-unique',
    search:
      '  CREATE UNIQUE INDEX "inviteeCustomer_1_idx" ON "invitation_reward_claims" USING btree ("invitee_customer_id");\n',
    replacement: '',
  },
  {
    group: 'claims',
    id: 'claim-source-order-unique',
    search:
      '  CREATE UNIQUE INDEX "sourceOrder_idx" ON "invitation_reward_claims" USING btree ("source_order_id");\n',
    replacement: '',
  },
  {
    group: 'events',
    id: 'event-lifecycle-batch-shape',
    search: `      (("event_type" IN ('pending', 'available') AND "points_batch_id" IS NOT NULL) OR\n       ("event_type" IN ('withheld', 'flagged_after_release') AND "points_batch_id" IS NULL))\n`,
    replacement: '      true\n',
  },
  {
    group: 'events',
    id: 'event-key-unique',
    search:
      '  CREATE UNIQUE INDEX "invitation_reward_events_event_key_idx" ON "invitation_reward_events" USING btree ("event_key");\n',
    replacement: '',
  },
  {
    group: 'events',
    id: 'event-claim-type-unique',
    search:
      '  CREATE UNIQUE INDEX "claim_eventType_idx" ON "invitation_reward_events" USING btree ("claim_id","event_type");\n',
    replacement: '',
  },
  {
    group: 'events',
    id: 'signal-order-unique',
    search:
      '  CREATE UNIQUE INDEX "invitation_reward_events_signals_parent_order_idx" ON "invitation_reward_events_signals" USING btree ("parent_id", "order");\n',
    replacement: '',
  },
  {
    group: 'events',
    id: 'signal-value-unique',
    search:
      '  CREATE UNIQUE INDEX "invitation_reward_events_signals_parent_value_idx" ON "invitation_reward_events_signals" USING btree ("parent_id", "value");\n',
    replacement: '',
  },
  {
    group: 'payer-hash',
    id: 'payment-notification-hash-shape',
    search: `    ALTER TABLE "payment_notifications" ADD CONSTRAINT "payment_notifications_payer_identifier_hash_valid" CHECK (\n      "payer_identifier_hash" IS NULL OR "payer_identifier_hash" ~ '^[a-f0-9]{64}$'\n    );\n`,
    replacement: '',
  },
  {
    group: 'payer-hash',
    id: 'payment-archive-hash-shape',
    search: `    ALTER TABLE "payment_notification_archives" ADD CONSTRAINT "payment_notification_archives_payer_identifier_hash_valid" CHECK (\n      "payer_identifier_hash" IS NULL OR "payer_identifier_hash" ~ '^[a-f0-9]{64}$'\n    );\n`,
    replacement: '',
  },
  {
    group: 'payer-hash',
    id: 'top-up-hash-shape',
    search: `    ALTER TABLE "wallet_top_up_orders" ADD CONSTRAINT "wallet_top_up_orders_payer_identifier_hash_valid" CHECK (\n      "payer_identifier_hash" IS NULL OR "payer_identifier_hash" ~ '^[a-f0-9]{64}$'\n    );\n`,
    replacement: '',
  },
  {
    group: 'down-guard',
    id: 'reward-fact-down-guard',
    search: `     IF EXISTS (SELECT 1 FROM "points_batches" WHERE "source_type" = 'invitation_reward') THEN\n       RAISE EXCEPTION 'cannot roll back D9-E-1 while invitation reward points batches exist';\n     END IF;\n`,
    replacement: '',
  },
  {
    group: 'down-guard',
    id: 'notification-fact-down-guard',
    search: `     IF EXISTS (SELECT 1 FROM "notification_outbox_events" WHERE "notification_type" = 'invitation_reward_withheld') THEN\n       RAISE EXCEPTION 'cannot roll back D9-E-1 while invitation reward notifications exist';\n     END IF;\n`,
    replacement: '',
  },
]) {
  exactMutation({
    file: migrationPath,
    input: 'D9E1_MIGRATION_SOURCE_BASE64',
    source: migrationSource,
    ...mutation,
  })
}

function stripAnsi(value) {
  return value.replaceAll(/\u001B\[[0-?]*[ -/]*[@-~]/gu, '')
}

const selectors = process.argv.slice(2)
if (selectors.includes('--list')) {
  for (const mutation of mutations) {
    process.stdout.write(`${mutation.group}\t${mutation.id}\t${mutation.file}\n`)
  }
  process.stdout.write(`TOTAL\t${mutations.length}\n`)
  process.exit(0)
}
if (selectors.includes('--validate')) {
  let invalid = 0
  for (const mutation of mutations) {
    try {
      mutation.transform(mutation.source)
    } catch (error) {
      invalid += 1
      process.stderr.write(`MUTATION SETUP FAILED ${mutation.id}: ${error.message}\n`)
    }
  }
  process.stdout.write(`VALIDATED\t${mutations.length - invalid}/${mutations.length}\n`)
  process.exit(invalid ? 1 : 0)
}
const selected = selectors.length
  ? mutations.filter(
      (mutation) => selectors.includes(mutation.group) || selectors.includes(mutation.id),
    )
  : mutations
if (!selected.length) {
  process.stderr.write(`No D9-E-1 migration mutations matched: ${selectors.join(', ')}\n`)
  process.exit(2)
}

let failed = false
let killed = 0
for (const mutation of selected) {
  const env = { ...process.env }
  env[mutation.input] = Buffer.from(mutation.transform(mutation.source)).toString('base64')
  const result = spawnSync('node', [verifier], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  })
  const output = stripAnsi(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  const assertion = output.split('\n').find((line) => line.includes('AssertionError')) ?? ''
  process.stdout.write(`\nMUTATION ${mutation.group}/${mutation.id}\n`)
  process.stdout.write(`RAW_FAILURE ${assertion}\n`)
  if (result.status !== 0 && output.includes('AssertionError')) {
    killed += 1
    process.stdout.write('RESULT KILLED_BY_BEHAVIOR\n')
  } else {
    process.stderr.write(
      `${result.status === 0 ? 'SURVIVED' : 'NON_BEHAVIORAL_FAILURE'} ${mutation.id}\n`,
    )
    failed = true
  }
}
process.stdout.write(`\nD9E1_MIGRATION_MUTATION_SUMMARY\nTOTAL\t${killed}/${selected.length}\n`)
if (failed) process.exitCode = 1
