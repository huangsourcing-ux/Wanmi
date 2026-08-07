import config from '@payload-config'
import { getPayload } from 'payload'

import { isAdPublicId } from '@/lib/advertising'
import { resolvePublicAdTarget, type ResolvedAdTarget } from '@/services/advertising/read-public-ad'

type AdRedirectContext = { params: Promise<{ publicId: string }> }

const redirectHeaders = {
  'Cache-Control': 'private, no-store, max-age=0',
  'Referrer-Policy': 'origin',
  'X-Robots-Tag': 'noindex, nofollow',
}

export function buildAdRedirectResponse(
  request: Request,
  resolved: ResolvedAdTarget | null,
): Response {
  if (!resolved) return new Response(null, { headers: redirectHeaders, status: 404 })
  const location = resolved.external
    ? new URL(resolved.targetUrl)
    : new URL(resolved.targetUrl, request.url)
  return new Response(null, {
    headers: { ...redirectHeaders, Location: location.toString() },
    status: 302,
  })
}

export async function GET(request: Request, { params }: AdRedirectContext): Promise<Response> {
  const { publicId } = await params
  if (!isAdPublicId(publicId)) return buildAdRedirectResponse(request, null)
  const payload = await getPayload({ config })
  const resolved = await resolvePublicAdTarget(payload, publicId.toLowerCase())
  return buildAdRedirectResponse(request, resolved)
}
