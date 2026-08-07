import { createHash } from 'node:crypto'

import sharp from 'sharp'

import { AppError } from '@/lib/errors'

export type ValidatedRealnameFile = {
  body: Uint8Array
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png'
  fileKind: 'jpeg' | 'pdf' | 'png'
  sha256: string
  sizeBytes: number
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const EICAR_SIGNATURE = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
const DANGEROUS_PDF_TOKENS = [
  '/AA',
  '/AcroForm',
  '/EmbeddedFile',
  '/Encrypt',
  '/JavaScript',
  '/JS',
  '/Launch',
  '/OpenAction',
  '/RichMedia',
  '/SubmitForm',
  '/XFA',
] as const

function invalidFile(code = 'REALNAME_DOCUMENT_INVALID'): never {
  throw new AppError(code, '证件文件未通过安全检查', 422, {
    action: '请上传清晰的 JPG、PNG 或 PDF 文件',
    retryable: false,
    title: '证件文件不可用',
  })
}

function identifyFile(body: Buffer): ValidatedRealnameFile['fileKind'] {
  if (body.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return 'png'
  if (body.length >= 4 && body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'jpeg'
  if (body.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf'
  return invalidFile('REALNAME_DOCUMENT_TYPE_NOT_ALLOWED')
}

function validatePngStructure(body: Buffer): void {
  let offset = PNG_SIGNATURE.length
  let sawHeader = false
  while (offset + 12 <= body.length) {
    const dataLength = body.readUInt32BE(offset)
    if (dataLength > body.length - offset - 12) invalidFile()
    const type = body.subarray(offset + 4, offset + 8).toString('ascii')
    if (!/^[A-Za-z]{4}$/u.test(type)) invalidFile()
    if (!sawHeader && type !== 'IHDR') invalidFile()
    sawHeader = true
    offset += dataLength + 12
    if (type === 'IEND') {
      if (dataLength !== 0 || offset !== body.length) invalidFile()
      return
    }
  }
  invalidFile()
}

async function validateAndNormalizeImage(body: Buffer, fileKind: 'jpeg' | 'png'): Promise<Buffer> {
  if (fileKind === 'png') validatePngStructure(body)
  if (fileKind === 'jpeg' && !body.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) invalidFile()
  try {
    const metadata = await sharp(body, {
      failOn: 'warning',
      limitInputPixels: 25_000_000,
    }).metadata()
    if (metadata.format !== fileKind || !metadata.width || !metadata.height) invalidFile()
    if (metadata.width < 64 || metadata.height < 64) invalidFile()
    const normalized = sharp(body, { failOn: 'warning', limitInputPixels: 25_000_000 }).rotate()
    return fileKind === 'png'
      ? await normalized.png({ compressionLevel: 9 }).toBuffer()
      : await normalized.jpeg({ quality: 92 }).toBuffer()
  } catch {
    invalidFile()
  }
}

function validatePdf(body: Buffer): void {
  const tail = body.subarray(Math.max(0, body.length - 2048)).toString('latin1')
  if (!/%%EOF[\t\n\f\r ]*$/u.test(tail)) invalidFile()
  const text = body.toString('latin1')
  if (DANGEROUS_PDF_TOKENS.some((token) => text.includes(token))) {
    invalidFile('REALNAME_DOCUMENT_MALICIOUS')
  }
}

function scanKnownThreats(body: Buffer): void {
  const text = body.toString('latin1')
  if (text.includes(EICAR_SIGNATURE)) invalidFile('REALNAME_DOCUMENT_MALICIOUS')
  if (
    body.subarray(0, 2).toString('ascii') === 'MZ' ||
    body.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    body.subarray(0, 4).equals(Buffer.from([0xca, 0xfe, 0xba, 0xbe])) ||
    body.subarray(0, 4).equals(Buffer.from([0xcf, 0xfa, 0xed, 0xfe]))
  ) {
    invalidFile('REALNAME_DOCUMENT_MALICIOUS')
  }
}

export async function validateRealnameFile(
  input: Uint8Array,
  maxBytes: number,
): Promise<ValidatedRealnameFile> {
  if (input.byteLength < 32) invalidFile()
  if (input.byteLength > maxBytes) {
    throw new AppError('REALNAME_DOCUMENT_TOO_LARGE', '证件文件超过大小限制', 413, {
      action: '请压缩文件后重试',
      retryable: false,
      title: '证件文件过大',
    })
  }
  const receivedBody = Buffer.from(input)
  scanKnownThreats(receivedBody)
  const fileKind = identifyFile(receivedBody)
  if (fileKind === 'pdf') validatePdf(receivedBody)
  const body =
    fileKind === 'pdf' ? receivedBody : await validateAndNormalizeImage(receivedBody, fileKind)

  return {
    body,
    contentType:
      fileKind === 'pdf' ? 'application/pdf' : fileKind === 'png' ? 'image/png' : 'image/jpeg',
    fileKind,
    sha256: createHash('sha256').update(body).digest('hex'),
    sizeBytes: body.byteLength,
  }
}
