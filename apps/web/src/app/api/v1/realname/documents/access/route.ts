import config from '@payload-config'
import { getPayload } from 'payload'

import { AppError, getTraceId, problemResponse } from '@/lib/errors'
import { authenticatedCustomerRequest } from '@/services/auth/otp'
import { readRealnameDocument } from '@/services/realname/documents'

const fileExtensions = { jpeg: 'jpg', pdf: 'pdf', png: 'png' } as const

export async function GET(request: Request) {
  const traceId = getTraceId(request.headers)
  try {
    const ticket = new URL(request.url).searchParams.get('ticket')
    if (!ticket) throw new AppError('REALNAME_DOCUMENT_NOT_AVAILABLE', '该证件文件当前不可用', 404)
    const payload = await getPayload({ config })
    const { req } = await authenticatedCustomerRequest(payload, request)
    const document = await readRealnameDocument(req, ticket)
    const disposition = document.mode === 'download' ? 'attachment' : 'inline'
    return new Response(document.body, {
      headers: {
        'cache-control': 'private, no-store, max-age=0',
        'content-disposition': `${disposition}; filename="identity-document.${fileExtensions[document.fileKind]}"`,
        'content-security-policy': "default-src 'none'; sandbox",
        'content-type': document.contentType,
        'cross-origin-resource-policy': 'same-origin',
        pragma: 'no-cache',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
        'x-request-id': traceId,
      },
      status: 200,
    })
  } catch (error) {
    return problemResponse(error, traceId)
  }
}
