import type { ReactNode } from 'react'

import { getSiteOrigin } from '@/lib/seo'
import { isExternalContentLink, sanitizeContentLink } from '@/services/content/rich-text'
import type { ContentMedia } from '@/services/content/read-content'

type NodeRecord = Record<string, unknown>

function isRecord(value: unknown): value is NodeRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function childrenOf(node: NodeRecord, media: Record<string, ContentMedia>): ReactNode[] {
  if (!Array.isArray(node.children)) return []
  return node.children.map((child, index) => renderNode(child, media, index))
}

function renderText(node: NodeRecord): ReactNode {
  let value: ReactNode = typeof node.text === 'string' ? node.text : ''
  const format = typeof node.format === 'number' ? node.format : 0
  if (format & 16) value = <code>{value}</code>
  if (format & 8) value = <u>{value}</u>
  if (format & 2) value = <em>{value}</em>
  if (format & 1) value = <strong>{value}</strong>
  return value
}

function uploadId(value: unknown): string | null {
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (isRecord(value) && (typeof value.id === 'number' || typeof value.id === 'string')) {
    return String(value.id)
  }
  return null
}

function renderNode(
  candidate: unknown,
  media: Record<string, ContentMedia>,
  key: number | string,
): ReactNode {
  if (!isRecord(candidate) || typeof candidate.type !== 'string') return null
  const children = childrenOf(candidate, media)
  if (candidate.type === 'text') return <span key={key}>{renderText(candidate)}</span>
  if (candidate.type === 'linebreak') return <br key={key} />
  if (candidate.type === 'paragraph') return <p key={key}>{children}</p>
  if (candidate.type === 'quote') return <blockquote key={key}>{children}</blockquote>
  if (candidate.type === 'heading') {
    if (candidate.tag === 'h2') return <h2 key={key}>{children}</h2>
    if (candidate.tag === 'h3') return <h3 key={key}>{children}</h3>
    return <h4 key={key}>{children}</h4>
  }
  if (candidate.type === 'list') {
    return candidate.listType === 'number' ? (
      <ol key={key} start={typeof candidate.start === 'number' ? candidate.start : undefined}>
        {children}
      </ol>
    ) : (
      <ul key={key}>{children}</ul>
    )
  }
  if (candidate.type === 'listitem') return <li key={key}>{children}</li>
  if (candidate.type === 'link' && isRecord(candidate.fields)) {
    const href = sanitizeContentLink(candidate.fields.url)
    const external = isExternalContentLink(href, getSiteOrigin().origin)
    return (
      <a
        href={href}
        key={key}
        rel={external ? 'nofollow noopener' : candidate.fields.newTab ? 'noopener' : undefined}
        target={candidate.fields.newTab ? '_blank' : undefined}
      >
        {children}
      </a>
    )
  }
  if (candidate.type === 'upload' && candidate.relationTo === 'media') {
    const id = uploadId(candidate.value)
    const image = id ? media[id] : undefined
    if (!image) return null
    return (
      <figure key={key}>
        {/* eslint-disable-next-line @next/next/no-img-element -- signed OSS URLs are resolved from Payload Media */}
        <img
          alt={image.alt}
          decoding="async"
          height={image.height ?? undefined}
          loading="lazy"
          src={image.url}
          width={image.width ?? undefined}
        />
        {image.alt ? <figcaption>{image.alt}</figcaption> : null}
      </figure>
    )
  }
  if (candidate.type === 'root') return <>{children}</>
  return null
}

export function RichTextContent({
  content,
  media,
}: {
  content: Record<string, unknown>
  media: Record<string, ContentMedia>
}) {
  const root = isRecord(content.root) ? content.root : null
  return <div className="content-rich-text">{root ? renderNode(root, media, 'root') : null}</div>
}
