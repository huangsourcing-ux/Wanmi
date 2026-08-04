import { constants, copyFile, readFile, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'

const target = new URL('../apps/web/.env.local', import.meta.url)
const source = new URL('../.env.example', import.meta.url)

try {
  await copyFile(source, target, constants.COPYFILE_EXCL)
  let contents = await readFile(target, 'utf8')
  contents = contents
    .replace('replace-with-32-byte-local-secret', randomBytes(32).toString('base64url'))
    .replace('replace-with-32-byte-local-pepper', randomBytes(32).toString('base64url'))
    .replace('replace-with-base64-encoded-32-byte-key', randomBytes(32).toString('base64'))
  await writeFile(target, contents, { mode: 0o600 })
  process.stdout.write('Created apps/web/.env.local with local-only random secrets.\n')
} catch (error) {
  if (error?.code !== 'EEXIST') throw error
  process.stdout.write('apps/web/.env.local already exists; left unchanged.\n')
}
