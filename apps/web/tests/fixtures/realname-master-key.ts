import { randomBytes } from 'node:crypto'

import type { RealnameDocumentMasterKeyring } from '@/services/realname/master-key'

export function createTestRealnameDocumentMasterKeyring(input?: {
  activeVersion?: string
  keys?: ReadonlyMap<string, Uint8Array>
}): RealnameDocumentMasterKeyring {
  const activeVersion = input?.activeVersion ?? 'test-v1'
  const keys = input?.keys ?? new Map([[activeVersion, randomBytes(32)]])
  return {
    activeVersion,
    keyForVersion(version) {
      const key = keys.get(version)
      return key ? Buffer.from(key) : undefined
    },
  }
}
