import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { collections } from '@/collections'
import { INVITATION_ABUSE_SIGNALS } from '@/collections/invitations'
import { invitationBindSchema } from '@/schemas/auth'
import {
  generateInvitationCode,
  INVITATION_CODE_PATTERN,
  LEGACY_INVITATION_CODE_PATTERN,
  normalizeInvitationCode,
} from '@/services/invitations/binding'

const appendOnlySlugs = [
  'invitationRewardRuleVersions',
  'invitationRelationships',
  'invitationRewardClaims',
  'invitationRewardEvents',
] as const

function collection(slug: string) {
  const found = collections.find((candidate) => candidate.slug === slug)
  if (!found) throw new Error(`Missing collection: ${slug}`)
  return found
}

describe('D9-E-1 invitation contracts', () => {
  it('encodes all 128 random bits and produces non-enumerable invitation codes', () => {
    const observedSizes: number[] = []
    const code = generateInvitationCode((size) => {
      observedSizes.push(size)
      return Uint8Array.from({ length: size }, (_, index) => index)
    })
    expect(observedSizes).toEqual([16])
    expect(code).toHaveLength(22)
    expect(INVITATION_CODE_PATTERN.test(code)).toBe(true)
    expect(Buffer.from(code, 'base64url')).toEqual(Buffer.from([...Array(16).keys()]))
    expect(normalizeInvitationCode(code)).toBe(code)

    const samples = Array.from({ length: 2_048 }, () => generateInvitationCode())
    expect(new Set(samples).size).toBe(samples.length)
    expect(samples.every((sample) => Buffer.from(sample, 'base64url').length === 16)).toBe(true)
    expect(() => generateInvitationCode(() => new Uint8Array(15))).toThrowError(
      expect.objectContaining({ code: 'INVITATION_CODE_ENTROPY_UNAVAILABLE' }),
    )
  })

  it('accepts the full legacy 12-character input range without weakening new 128-bit generation', () => {
    expect(LEGACY_INVITATION_CODE_PATTERN.test('ABCDEF123456')).toBe(true)
    expect(normalizeInvitationCode('abcdef123456')).toBe('ABCDEF123456')
    expect(normalizeInvitationCode('legacycode9z')).toBe('LEGACYCODE9Z')
    expect(generateInvitationCode()).toMatch(INVITATION_CODE_PATTERN)
  })

  it('rejects client-supplied registration time instead of expanding the server window', () => {
    expect(
      invitationBindSchema.safeParse({
        deviceId: 'device-fixture-123456',
        invitationCode: generateInvitationCode(),
        registeredAt: '2099-01-01T00:00:00.000Z',
      }).success,
    ).toBe(false)
  })

  it('rejects generic mutations and both update/delete hook callpoints for append-only records', async () => {
    for (const slug of appendOnlySlugs) {
      const config = collection(slug)
      for (const operation of ['create', 'update', 'delete'] as const) {
        const access = config.access?.[operation]
        if (typeof access !== 'function') throw new Error(`${slug}.${operation} access missing`)
        expect(await access({} as never)).toBe(false)
      }
      const beforeChange = config.hooks?.beforeChange?.[0]
      const beforeDelete = config.hooks?.beforeDelete?.[0]
      expect(beforeChange).toBeTypeOf('function')
      expect(beforeDelete).toBeTypeOf('function')
      if (!beforeChange || !beforeDelete) continue
      await expect(async () =>
        beforeChange({ operation: 'update' } as never),
      ).rejects.toMatchObject({
        status: 409,
      })
      await expect(async () => beforeDelete({} as never)).rejects.toMatchObject({ status: 409 })
    }
  })

  it('keeps abuse signal ordering deterministic and excludes automatic clawback/account changes', () => {
    expect(INVITATION_ABUSE_SIGNALS).toEqual([
      'same_device_hash',
      'same_realname_subject',
      'same_phone_hash',
      'same_payment_account_hash',
      'abnormal_invitation_growth',
    ])
    const rewardsSource = readFileSync(
      fileURLToPath(new URL('../../src/services/invitations/rewards.ts', import.meta.url)),
      'utf8',
    )
    expect(rewardsSource).toContain('INVITATION_ABUSE_SIGNALS.filter')
    expect(rewardsSource).not.toContain('reversePendingOrderReward')
    expect(rewardsSource).not.toContain('transitionCustomerAccount')
    expect(rewardsSource).not.toMatch(/fingerprint|canvas|webgl/iu)
  })
})
