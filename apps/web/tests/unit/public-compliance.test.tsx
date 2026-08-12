// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react'
import type { Payload } from 'payload'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RegistrarDisclosure } from '@/components/compliance/registrar-disclosure'
import { SiteFooter } from '@/components/site/site-footer'
import {
  DEFAULT_PUBLIC_COMPLIANCE_CONFIG,
  ICP_REGISTRATION_URL,
  PUBLIC_COMPLIANCE_SETTING_KEY,
  readPublicComplianceConfig,
} from '@/lib/public-compliance'

function payloadWithValue(value?: unknown): Pick<Payload, 'find'> {
  return {
    find: vi.fn().mockResolvedValue({ docs: value === undefined ? [] : [{ value }] }) as never,
  }
}

afterEach(cleanup)

describe('D8-01 public compliance configuration and rendering', () => {
  it('renders no registration identifier or registration link when none is configured', async () => {
    const payload = payloadWithValue()
    const compliance = await readPublicComplianceConfig(payload)

    render(<SiteFooter compliance={compliance} />)

    expect(compliance).toEqual(DEFAULT_PUBLIC_COMPLIANCE_CONFIG)
    expect(payload.find).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'siteSettings',
        overrideAccess: false,
        where: { key: { equals: PUBLIC_COMPLIANCE_SETTING_KEY } },
      }),
    )
    expect(document.querySelector(`a[href="${ICP_REGISTRATION_URL}"]`)).toBeNull()
    expect(document.body.textContent).not.toContain('ICP备')
    expect(document.body.textContent).not.toContain('公网安备')
  })

  it('renders configured registration identifiers with correct links and honors the notice switch', async () => {
    const publicSecurityUrl =
      'https://www.beian.gov.cn/portal/registerSystemInfo?recordcode=50000000000001'
    const compliance = await readPublicComplianceConfig(
      payloadWithValue({
        icpRegistrationNumber: '渝ICP备18017546-13',
        publicSecurityRegistration: {
          number: '渝公网安备 50000000000001号',
          url: publicSecurityUrl,
        },
        registrarName: '配置的注册服务机构',
        schemaVersion: 1,
        showPrelaunchNotice: false,
      }),
    )

    render(<SiteFooter compliance={compliance} />)

    expect(screen.getByRole('link', { name: '渝ICP备18017546-13' }).getAttribute('href')).toBe(
      ICP_REGISTRATION_URL,
    )
    expect(
      screen.getByRole('link', { name: '渝公网安备 50000000000001号' }).getAttribute('href'),
    ).toBe(publicSecurityUrl)
    expect(document.body.textContent).not.toContain(
      '生产服务上线前仍需完成资质、备案、合规复核及最终批准',
    )
    expect(document.body.textContent).toContain('配置的注册服务机构')
  })

  it('renders a prominent registrar disclosure only when a configured institution is provided', () => {
    const { rerender } = render(<RegistrarDisclosure />)
    expect(document.querySelector('[data-registrar-disclosure]')).toBeNull()

    rerender(<RegistrarDisclosure registrarName="配置的注册服务机构" />)
    expect(screen.getByRole('heading', { name: '域名注册服务机构披露' })).not.toBeNull()
    expect(document.body.textContent).toContain('Wanmi 提供域名代理注册服务')
    expect(document.body.textContent).toContain('实际域名注册服务机构为配置的注册服务机构')
    expect(screen.getByRole('link', { name: '《使用条款》' }).getAttribute('href')).toBe(
      '/legal/terms',
    )
  })
})
