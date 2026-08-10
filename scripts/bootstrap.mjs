import { chmod, constants, copyFile, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const source = new URL('../.env.example', import.meta.url)
const defaultTarget = new URL('../apps/web/.env.local', import.meta.url)
const localMasterKeyVersion = 'local-v1'

export async function createLocalEnvironment(target = defaultTarget) {
  try {
    await copyFile(source, target, constants.COPYFILE_EXCL)
    const localMasterKey = randomBytes(32).toString('base64')
    let contents = await readFile(target, 'utf8')
    contents = contents
      .replace('replace-with-32-byte-local-secret', randomBytes(32).toString('base64url'))
      .replace('replace-with-32-byte-local-pepper', randomBytes(32).toString('base64url'))
      .replace('replace-with-base64-encoded-32-byte-key', randomBytes(32).toString('base64'))
      .replace(
        '# REALNAME_DOCUMENT_MASTER_KEYS=',
        `REALNAME_DOCUMENT_MASTER_KEYS=${localMasterKeyVersion}:${localMasterKey}`,
      )
      .replace(
        '# REALNAME_DOCUMENT_MASTER_KEY_VERSION=',
        `REALNAME_DOCUMENT_MASTER_KEY_VERSION=${localMasterKeyVersion}`,
      )
    await writeFile(target, contents, { mode: 0o600 })
    await chmod(target, 0o600)
    return true
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    return false
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined
if (invokedPath === fileURLToPath(import.meta.url)) {
  const created = await createLocalEnvironment()
  process.stdout.write(
    created
      ? 'Created apps/web/.env.local with local-only random secrets.\n'
      : 'apps/web/.env.local already exists; left unchanged.\n',
  )
}
