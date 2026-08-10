import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'

import type { PayloadRequest } from 'payload'

import { hasRole, isActiveAdminUser, isCustomerUser } from '@/access/roles'
import { getEnv } from '@/lib/env'
import { AppError } from '@/lib/errors'
import { getTraceId } from '@/lib/request-id'
import { createRealnameObjectProvider } from '@/providers/oss-realname'
import type { RealnameObjectProvider } from '@/providers/types'
import { recordAuditEvent } from '@/services/audit/record-audit-event'

import {
  decryptDocumentEnvelope,
  encryptDocumentEnvelope,
  type DocumentEnvelopeMetadata,
} from './document-envelope'
import { validateRealnameFile } from './file-validation'
import {
  createRealnameDocumentMasterKeyring,
  type RealnameDocumentMasterKeyring,
} from './master-key'

type CustomerIdentity = { collection?: string; id: number | string; status?: string | null }
type DocumentRecord = Record<string, unknown> & { id: number | string }
type TemplateRecord = Record<string, unknown> & { id: number | string }
type DocumentAccessMode = 'download' | 'view'
type DocumentProviders = {
  keyring: RealnameDocumentMasterKeyring
  objects: RealnameObjectProvider
}

type AccessTicket = {
  actorId: string
  actorType: 'admin' | 'customer'
  documentId: string
  expiresAt: number
  mode: DocumentAccessMode
  nonce: string
  version: 1
}

function relationshipId(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return String(value)
  if (typeof value !== 'object' || value === null) return undefined
  const id = (value as { id?: unknown }).id
  return typeof id === 'number' || typeof id === 'string' ? String(id) : undefined
}

function requireCustomer(req: PayloadRequest): CustomerIdentity {
  if (!isCustomerUser(req.user) || (req.user as CustomerIdentity).status !== 'active') {
    throw new AppError('REALNAME_AUTH_REQUIRED', '请重新验证身份后再试', 401)
  }
  return req.user as CustomerIdentity
}

function requireSystemAdmin(req: PayloadRequest): { id: number | string } {
  if (!isActiveAdminUser(req.user) || !hasRole(req.user, ['system_admin'])) {
    throw new AppError('ADMIN_SYSTEM_ROLE_REQUIRED', '仅系统管理员可执行此操作', 403)
  }
  return req.user
}

function documentUnavailable(): never {
  throw new AppError('REALNAME_DOCUMENT_NOT_AVAILABLE', '该证件文件当前不可用', 404)
}

async function ownedTemplate(req: PayloadRequest, templateId: number | string) {
  const customer = requireCustomer(req)
  try {
    const template = (await req.payload.findByID({
      collection: 'realnameTemplates',
      depth: 0,
      id: templateId,
      overrideAccess: false,
      req,
      user: req.user,
    })) as unknown as TemplateRecord
    if (relationshipId(template.customer) !== String(customer.id)) throw new Error('not owned')
    return template
  } catch {
    throw new AppError('REALNAME_TEMPLATE_NOT_AVAILABLE', '该实名模板当前不可用', 404)
  }
}

async function ownedDocument(req: PayloadRequest, documentId: number | string) {
  const customer = requireCustomer(req)
  try {
    const document = (await req.payload.findByID({
      collection: 'realnameDocuments',
      depth: 0,
      id: documentId,
      overrideAccess: false,
      req,
      user: req.user,
    })) as unknown as DocumentRecord
    if (relationshipId(document.customer) !== String(customer.id)) documentUnavailable()
    return document
  } catch {
    documentUnavailable()
  }
}

async function loadProtectedDocumentMaterial(
  req: PayloadRequest,
  authorizedDocument: DocumentRecord,
): Promise<DocumentRecord> {
  const protectedDocument = (await req.payload.findByID({
    collection: 'realnameDocuments',
    depth: 0,
    id: authorizedDocument.id,
    overrideAccess: true,
    req,
  })) as unknown as DocumentRecord
  if (
    relationshipId(protectedDocument.customer) !== relationshipId(authorizedDocument.customer) ||
    relationshipId(protectedDocument.template) !== relationshipId(authorizedDocument.template)
  ) {
    documentUnavailable()
  }
  return protectedDocument
}

function defaultProviders(): DocumentProviders {
  return {
    keyring: createRealnameDocumentMasterKeyring(),
    objects: createRealnameObjectProvider(),
  }
}

function safeSummary(document: DocumentRecord) {
  return {
    contentType: document.contentType,
    fileKind: document.fileKind,
    id: document.id,
    sizeBytes: document.sizeBytes,
    status: document.submittedAt ? ('submitted' as const) : ('active' as const),
  }
}

function signingKey(): Buffer {
  return createHmac('sha256', getEnv().SESSION_PEPPER)
    .update('wanmi-realname-document-access-v1')
    .digest()
}

function signAccessTicket(ticket: AccessTicket): string {
  const payload = Buffer.from(JSON.stringify(ticket), 'utf8').toString('base64url')
  const signature = createHmac('sha256', signingKey()).update(payload).digest('base64url')
  return `${payload}.${signature}`
}

function verifyAccessTicket(token: string): AccessTicket {
  const [payload, suppliedSignature, extra] = token.split('.')
  if (!payload || !suppliedSignature || extra) documentUnavailable()
  const expectedSignature = createHmac('sha256', signingKey()).update(payload).digest()
  const supplied = Buffer.from(suppliedSignature, 'base64url')
  if (
    supplied.toString('base64url') !== suppliedSignature ||
    supplied.length !== expectedSignature.length ||
    !timingSafeEqual(supplied, expectedSignature)
  ) {
    documentUnavailable()
  }
  try {
    const ticket = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<AccessTicket>
    if (
      ticket.version !== 1 ||
      typeof ticket.actorId !== 'string' ||
      (ticket.actorType !== 'admin' && ticket.actorType !== 'customer') ||
      typeof ticket.documentId !== 'string' ||
      typeof ticket.expiresAt !== 'number' ||
      !Number.isSafeInteger(ticket.expiresAt) ||
      (ticket.mode !== 'view' && ticket.mode !== 'download') ||
      typeof ticket.nonce !== 'string' ||
      ticket.nonce.length < 32 ||
      ticket.expiresAt < Date.now() ||
      ticket.expiresAt > Date.now() + getEnv().REALNAME_DOCUMENT_ACCESS_TTL_SECONDS * 1000 + 5_000
    ) {
      documentUnavailable()
    }
    return ticket as AccessTicket
  } catch {
    documentUnavailable()
  }
}

function envelopeMetadata(document: DocumentRecord): DocumentEnvelopeMetadata {
  if (
    document.encryptionVersion !== 'aes-256-gcm-v1' ||
    typeof document.authTag !== 'string' ||
    typeof document.contentType !== 'string' ||
    typeof document.encryptedDataKey !== 'string' ||
    typeof document.iv !== 'string' ||
    typeof document.masterKeyVersion !== 'string' ||
    typeof document.sha256 !== 'string' ||
    typeof document.sizeBytes !== 'number'
  ) {
    documentUnavailable()
  }
  return {
    authTag: document.authTag,
    contentType: document.contentType,
    encryptedDataKey: document.encryptedDataKey,
    encryptionVersion: document.encryptionVersion,
    iv: document.iv,
    masterKeyVersion: document.masterKeyVersion,
    sha256: document.sha256,
    sizeBytes: document.sizeBytes,
  }
}

export async function uploadRealnameDocument(
  req: PayloadRequest,
  input: { body: Uint8Array; templateId: number | string },
  providers: DocumentProviders = defaultProviders(),
) {
  const env = getEnv()
  const customer = requireCustomer(req)
  const template = await ownedTemplate(req, input.templateId)
  if (template.status !== 'draft') {
    throw new AppError('REALNAME_DOCUMENT_UPLOAD_NOT_ALLOWED', '该实名模板当前不能上传证件', 409)
  }
  const existing = await req.payload.find({
    collection: 'realnameDocuments',
    depth: 0,
    limit: 5,
    overrideAccess: false,
    req,
    user: req.user,
    where: {
      and: [
        { template: { equals: template.id } },
        { storageState: { in: ['uploading', 'active'] } },
      ],
    },
  })
  if (existing.totalDocs >= 4) {
    throw new AppError('REALNAME_DOCUMENT_LIMIT_REACHED', '该实名模板的证件文件数量已达上限', 409)
  }

  const validated = await validateRealnameFile(input.body, env.REALNAME_DOCUMENT_MAX_BYTES)
  const traceId = getTraceId(req.headers)
  const encrypted = await encryptDocumentEnvelope({
    body: validated.body,
    contentType: validated.contentType,
    keyring: providers.keyring,
    sha256: validated.sha256,
  })
  const objectKey = `${env.OSS_REALNAME_PREFIX}/${randomUUID()}-${randomBytes(16).toString('hex')}.wrn`
  const document = (await req.payload.create({
    collection: 'realnameDocuments',
    data: {
      ...encrypted.metadata,
      customer: customer.id,
      fileKind: validated.fileKind,
      objectKey,
      storageState: 'uploading',
      template: template.id,
    } as never,
    overrideAccess: true,
    req,
  })) as unknown as DocumentRecord

  const uploaded = await providers.objects.upload({ body: encrypted.body, key: objectKey, traceId })
  if (!uploaded.ok) {
    await req.payload.update({
      collection: 'realnameDocuments',
      data: { storageState: 'upload_failed' },
      id: document.id,
      overrideAccess: true,
      req,
    })
    throw new AppError('REALNAME_DOCUMENT_STORAGE_UNAVAILABLE', '证件文件暂时无法保存', 503, {
      retryable: true,
    })
  }
  try {
    const active = (await req.payload.update({
      collection: 'realnameDocuments',
      data: { storageState: 'active' },
      id: document.id,
      overrideAccess: true,
      req,
    })) as unknown as DocumentRecord
    await recordAuditEvent(req, {
      action: 'realname.document.uploaded',
      metadata: { fileKind: validated.fileKind, sizeBytes: validated.sizeBytes },
      targetId: document.id,
    })
    return safeSummary(active)
  } catch (error) {
    await providers.objects.deleteObject({ key: objectKey, traceId }).catch(() => undefined)
    await req.payload
      .update({
        collection: 'realnameDocuments',
        data: { storageState: 'upload_failed' },
        id: document.id,
        overrideAccess: true,
        req,
      })
      .catch(() => undefined)
    throw error
  }
}

export async function createRealnameDocumentAccess(
  req: PayloadRequest,
  documentId: number | string,
  mode: DocumentAccessMode,
) {
  const customer = requireCustomer(req)
  const document = await ownedDocument(req, documentId)
  if (document.storageState !== 'active' || document.deletedAt) documentUnavailable()
  const expiresAtMs = Date.now() + getEnv().REALNAME_DOCUMENT_ACCESS_TTL_SECONDS * 1000
  const token = signAccessTicket({
    actorId: String(customer.id),
    actorType: 'customer',
    documentId: String(document.id),
    expiresAt: expiresAtMs,
    mode,
    nonce: randomBytes(24).toString('base64url'),
    version: 1,
  })
  const url = new URL('/api/v1/realname/documents/access', getEnv().NEXT_PUBLIC_SERVER_URL)
  url.searchParams.set('ticket', token)
  return { expiresAt: new Date(expiresAtMs).toISOString(), url: url.toString() }
}

export async function createAdminRealnameDocumentAccess(
  req: PayloadRequest,
  documentId: number | string,
  mode: DocumentAccessMode,
) {
  const admin = requireSystemAdmin(req)
  let document: DocumentRecord
  try {
    document = (await req.payload.findByID({
      collection: 'realnameDocuments',
      depth: 0,
      id: documentId,
      overrideAccess: true,
      req,
    })) as unknown as DocumentRecord
  } catch {
    documentUnavailable()
  }
  if (document.storageState !== 'active' || document.deletedAt) documentUnavailable()
  const expiresAtMs = Date.now() + getEnv().REALNAME_DOCUMENT_ACCESS_TTL_SECONDS * 1000
  const token = signAccessTicket({
    actorId: String(admin.id),
    actorType: 'admin',
    documentId: String(document.id),
    expiresAt: expiresAtMs,
    mode,
    nonce: randomBytes(24).toString('base64url'),
    version: 1,
  })
  const url = new URL('/api/v1/admin/realname/documents/access', getEnv().NEXT_PUBLIC_SERVER_URL)
  url.searchParams.set('ticket', token)
  return { expiresAt: new Date(expiresAtMs).toISOString(), url: url.toString() }
}

async function decryptAndAuditDocument(
  req: PayloadRequest,
  document: DocumentRecord,
  mode: DocumentAccessMode,
  providers: DocumentProviders,
) {
  if (typeof document.objectKey !== 'string') documentUnavailable()
  const traceId = getTraceId(req.headers)
  const stored = await providers.objects.read({ key: document.objectKey, traceId })
  if (!stored.ok) {
    throw new AppError('REALNAME_DOCUMENT_UNAVAILABLE', '证件文件暂时不可用', 503, {
      retryable: true,
    })
  }
  const body = await decryptDocumentEnvelope({
    body: stored.data.body,
    expected: envelopeMetadata(document),
    keyring: providers.keyring,
  })
  await recordAuditEvent(req, {
    action: mode === 'download' ? 'realname.document.downloaded' : 'realname.document.viewed',
    metadata: { mode },
    targetId: document.id,
  })
  return {
    body,
    contentType: String(document.contentType),
    fileKind: document.fileKind as 'jpeg' | 'pdf' | 'png',
    mode,
  }
}

export async function readRealnameDocument(
  req: PayloadRequest,
  token: string,
  providers: DocumentProviders = defaultProviders(),
) {
  const customer = requireCustomer(req)
  const ticket = verifyAccessTicket(token)
  if (ticket.actorType !== 'customer' || ticket.actorId !== String(customer.id)) {
    documentUnavailable()
  }
  const authorized = await ownedDocument(req, ticket.documentId)
  if (authorized.storageState !== 'active' || authorized.deletedAt) documentUnavailable()
  const document = await loadProtectedDocumentMaterial(req, authorized)
  return decryptAndAuditDocument(req, document, ticket.mode, providers)
}

export async function readAdminRealnameDocument(
  req: PayloadRequest,
  token: string,
  providers: DocumentProviders = defaultProviders(),
) {
  const admin = requireSystemAdmin(req)
  const ticket = verifyAccessTicket(token)
  if (ticket.actorType !== 'admin' || ticket.actorId !== String(admin.id)) documentUnavailable()
  let document: DocumentRecord
  try {
    document = (await req.payload.findByID({
      collection: 'realnameDocuments',
      depth: 0,
      id: ticket.documentId,
      overrideAccess: true,
      req,
    })) as unknown as DocumentRecord
  } catch {
    documentUnavailable()
  }
  if (document.storageState !== 'active' || document.deletedAt) documentUnavailable()
  return decryptAndAuditDocument(req, document, ticket.mode, providers)
}

export async function submitRealnameDocument(req: PayloadRequest, documentId: number | string) {
  const authorized = await ownedDocument(req, documentId)
  if (authorized.storageState !== 'active' || authorized.deletedAt) documentUnavailable()
  const submittedAt = new Date().toISOString()
  const submitted = (await req.payload.update({
    collection: 'realnameDocuments',
    data: { submittedAt },
    id: authorized.id,
    overrideAccess: true,
    req,
  })) as unknown as DocumentRecord
  await recordAuditEvent(req, {
    action: 'realname.document.submitted',
    metadata: { templateId: relationshipId(authorized.template) },
    targetId: authorized.id,
  })
  return { documentId: submitted.id, status: 'submitted' as const }
}

export async function deleteRealnameDocument(
  req: PayloadRequest,
  documentId: number | string,
  providers: DocumentProviders = defaultProviders(),
) {
  const authorized = await ownedDocument(req, documentId)
  if (authorized.storageState === 'deleted' || authorized.deletedAt) {
    return { documentId: authorized.id, status: 'deleted' as const }
  }
  if (authorized.storageState !== 'active') documentUnavailable()
  const document = await loadProtectedDocumentMaterial(req, authorized)
  if (typeof document.objectKey !== 'string') documentUnavailable()
  await req.payload.update({
    collection: 'realnameDocuments',
    data: { storageState: 'deleting' },
    id: document.id,
    overrideAccess: true,
    req,
  })
  const deleted = await providers.objects.deleteObject({
    key: document.objectKey,
    traceId: getTraceId(req.headers),
  })
  if (!deleted.ok) {
    await req.payload
      .update({
        collection: 'realnameDocuments',
        data: { storageState: 'active' },
        id: document.id,
        overrideAccess: true,
        req,
      })
      .catch(() => undefined)
    throw new AppError('REALNAME_DOCUMENT_DELETE_UNAVAILABLE', '证件文件暂时无法删除', 503, {
      retryable: true,
    })
  }
  const deletedAt = new Date().toISOString()
  await req.payload.update({
    collection: 'realnameDocuments',
    data: { deletedAt, storageState: 'deleted' },
    id: document.id,
    overrideAccess: true,
    req,
  })
  await recordAuditEvent(req, {
    action: 'realname.document.deleted',
    metadata: { templateId: relationshipId(document.template) },
    targetId: document.id,
  })
  return { documentId: document.id, status: 'deleted' as const }
}
