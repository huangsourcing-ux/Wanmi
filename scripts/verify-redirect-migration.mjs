import { execFileSync } from 'node:child_process'

const databaseName = `wanmi_redirect_migration_${process.pid}_${Date.now()}`
if (!/^wanmi_redirect_migration_[0-9]+_[0-9]+$/.test(databaseName)) {
  throw new Error(`Unexpected migration verification database name: ${databaseName}`)
}

const databaseUrl = `postgresql://wanmi:wanmi_local_only@127.0.0.1:55432/${databaseName}`
const run = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: options.capture ? 'pipe' : 'inherit',
  })

const postgres = (args, options) =>
  run('docker', ['compose', 'exec', '-T', 'postgres', ...args], options)

let created = false
try {
  postgres(['createdb', '--username', 'wanmi', databaseName])
  created = true

  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 2
     WHERE name = '20260805_005736_d1_redirect_foundation'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `INSERT INTO redirects ("from", to_type, to_url, "type", updated_at, created_at)
     VALUES ('/legacy-302', 'custom', '/current', '302', NOW(), NOW())`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])

  const result = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT r.type || ':' || array_to_string(enum_range(NULL::enum_redirects_type), ',')
       FROM redirects r WHERE r."from" = '/legacy-302'`,
    ],
    { capture: true },
  ).trim()
  if (result !== '301:301') {
    throw new Error(`Legacy redirect migration produced an unexpected result: ${result}`)
  }

  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `UPDATE payload_migrations SET batch = 3 WHERE name = '20260805_040152'`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'payload', 'migrate:down'])
  postgres([
    'psql',
    '--username',
    'wanmi',
    '--dbname',
    databaseName,
    '--set',
    'ON_ERROR_STOP=1',
    '--command',
    `DO $$
     DECLARE legacy_admin_id integer;
     BEGIN
       INSERT INTO admins (
         email, totp_secret_encrypted, totp_enabled, totp_last_used_step,
         updated_at, created_at, login_attempts
       ) VALUES (
         'legacy-admin@example.test', 'legacy-encrypted-secret', true, 4242,
         NOW(), NOW(), 0
       ) RETURNING id INTO legacy_admin_id;
       INSERT INTO admins_roles ("order", parent_id, value)
       VALUES (1, legacy_admin_id, 'system_admin');
       INSERT INTO admins_texts ("order", parent_id, path, text)
       VALUES (1, legacy_admin_id, 'recoveryCodeHashes', 'legacy-recovery-hash');
     END $$;`,
  ])
  run('pnpm', ['--filter', '@wanmi/web', 'migrate'])
  const adminMigration = postgres(
    [
      'psql',
      '--username',
      'wanmi',
      '--dbname',
      databaseName,
      '--tuples-only',
      '--no-align',
      '--command',
      `SELECT
         admin_account.status || ':' || credentials.secret_encrypted || ':' ||
         credentials.last_used_step || ':' || recovery.text
       FROM admins admin_account
       JOIN admin_mfa_credentials credentials ON credentials.admin_id = admin_account.id
       JOIN admin_mfa_credentials_texts recovery ON recovery.parent_id = credentials.id
       WHERE admin_account.email = 'legacy-admin@example.test'
         AND recovery.path = 'recoveryCodeHashes'`,
    ],
    { capture: true },
  ).trim()
  if (adminMigration !== 'active:legacy-encrypted-secret:4242:legacy-recovery-hash') {
    throw new Error(
      `Legacy administrator migration produced an unexpected result: ${adminMigration}`,
    )
  }

  let lastSystemAdminProtected = false
  try {
    postgres(
      [
        'psql',
        '--username',
        'wanmi',
        '--dbname',
        databaseName,
        '--set',
        'ON_ERROR_STOP=1',
        '--command',
        `UPDATE admins SET status = 'disabled' WHERE email = 'legacy-admin@example.test'`,
      ],
      { capture: true },
    )
  } catch {
    lastSystemAdminProtected = true
  }
  if (!lastSystemAdminProtected) {
    throw new Error('Database allowed the last active system administrator to be disabled')
  }

  process.stdout.write(
    'Verified empty-database migrations, D1-03 legacy redirects, D1-05 legacy administrator MFA, and the last-system-admin constraint.\n',
  )
} finally {
  if (created) {
    postgres(['dropdb', '--force', '--username', 'wanmi', databaseName])
  }
}
