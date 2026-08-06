import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RichTextContent } from '@/components/content/rich-text-content'
import { AppError } from '@/lib/errors'
import {
  collectMediaIds,
  sanitizeContentLink,
  sanitizeRichText,
} from '@/services/content/rich-text'

const text = (value: string, format = 0) => ({
  detail: 0,
  format,
  mode: 'normal',
  style: 'color:red',
  text: value,
  type: 'text',
  version: 1,
})

const root = (children: unknown[]) => ({
  root: {
    children,
    direction: null,
    format: '',
    indent: 0,
    type: 'root',
    version: 1,
  },
})

const paragraph = (children: unknown[]) => ({
  children,
  direction: null,
  format: 'justify',
  indent: 99,
  textFormat: 0,
  textStyle: 'background:url(javascript:alert(1))',
  type: 'paragraph',
  version: 1,
})

describe('D3 controlled rich text', () => {
  it('rebuilds allowed nodes and removes author supplied style and unsupported text formats', () => {
    const sanitized = sanitizeRichText(root([paragraph([text('安全内容', 1 | 2 | 4 | 8 | 16)])]))
    const serialized = JSON.stringify(sanitized)
    expect(serialized).not.toContain('color:red')
    expect(serialized).not.toContain('background:url')
    expect(serialized).not.toContain('justify')
    expect(serialized).toContain('"format":27')
  })

  it.each([
    'javascript:alert(1)',
    ' JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.test/file',
    '//evil.example/path',
    'https://user:pass@example.test/path',
  ])('rejects unsafe link %s', (href) => {
    expect(() => sanitizeContentLink(href)).toThrow(AppError)
  })

  it.each(['script', 'iframe', 'object', 'embed', 'html', 'relationship', 'block'])(
    'rejects forbidden %s nodes instead of persisting them',
    (type) => {
      expect(() => sanitizeRichText(root([{ type, version: 1 }]))).toThrow(AppError)
    },
  )

  it('stores only a media relationship ID and rejects external image nodes', () => {
    const sanitized = sanitizeRichText(
      root([
        {
          fields: { onclick: 'alert(1)' },
          id: 'upload-1',
          relationTo: 'media',
          src: 'https://evil.example/image.png',
          type: 'upload',
          value: { id: 42, url: 'https://evil.example/image.png' },
          version: 1,
        },
      ]),
    )
    expect(collectMediaIds(sanitized)).toEqual([42])
    expect(JSON.stringify(sanitized)).not.toContain('evil.example')
    expect(() =>
      sanitizeRichText(root([{ relationTo: 'uploads', type: 'upload', value: 42, version: 1 }])),
    ).toThrow(AppError)
  })

  it('renders external links with nofollow noopener and never uses embedded HTML', () => {
    const content = sanitizeRichText(
      root([
        paragraph([
          {
            children: [text('外部来源')],
            direction: null,
            fields: {
              linkType: 'custom',
              newTab: false,
              onmouseover: 'alert(1)',
              url: 'https://example.com/source',
            },
            format: '',
            indent: 0,
            type: 'link',
            version: 1,
          },
        ]),
      ]),
    )
    const markup = renderToStaticMarkup(<RichTextContent content={content} media={{}} />)
    expect(markup).toContain('rel="nofollow noopener"')
    expect(markup).not.toContain('onmouseover')
  })
})
