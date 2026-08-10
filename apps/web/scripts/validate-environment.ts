import { ZodError } from 'zod'

import { getEnv } from '../src/lib/env'

try {
  getEnv()
  process.stdout.write('Environment validation passed.\n')
} catch (error) {
  if (error instanceof ZodError) {
    for (const issue of error.issues) {
      process.stderr.write(`${issue.path.join('.') || 'environment'}: ${issue.message}\n`)
    }
  } else {
    process.stderr.write('Environment validation failed unexpectedly.\n')
  }
  process.exitCode = 1
}
