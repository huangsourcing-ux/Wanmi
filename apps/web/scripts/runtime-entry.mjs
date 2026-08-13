import { spawn } from 'node:child_process'

import { assertRuntimeEnvironment } from './runtime-environment-contract.mjs'

const role = process.argv[2]
const command = process.argv[3]
const args = process.argv.slice(4)

if (!['background-worker', 'commerce-worker', 'maintenance', 'web'].includes(role)) {
  process.stderr.write('Invalid runtime setting: WANMI_RUNTIME_ROLE\n')
  process.exit(64)
}
if (!command) {
  process.stderr.write('Runtime command is missing\n')
  process.exit(64)
}

try {
  assertRuntimeEnvironment(process.env)
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Runtime configuration invalid'}\n`,
  )
  process.exit(78)
}

const child = spawn(command, args, { env: process.env, stdio: 'inherit' })
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}
child.on('error', (error) => {
  process.stderr.write(`Runtime process could not start: ${error.code ?? 'UNKNOWN'}\n`)
  process.exit(70)
})
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})
