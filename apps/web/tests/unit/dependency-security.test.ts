import { imageSize } from 'image-size'
import { describe, expect, it } from 'vitest'

function writeAscii(input: Uint8Array, offset: number, value: string): void {
  input.set(new TextEncoder().encode(value), offset)
}

describe('patched image-size parser bounds', () => {
  it('rejects a zero-length ICNS entry instead of blocking the event loop', () => {
    const input = new Uint8Array(16)
    const view = new DataView(input.buffer)
    writeAscii(input, 0, 'icns')
    view.setUint32(4, input.length)
    writeAscii(input, 8, 'ic07')
    view.setUint32(12, 0)

    expect(() => imageSize(input)).toThrow(/Invalid ICNS entry length/u)
  })

  it('rejects a zero-length JXL box instead of repeatedly parsing the same offset', () => {
    const input = new Uint8Array(40)
    const view = new DataView(input.buffer)
    view.setUint32(0, 12)
    writeAscii(input, 4, 'JXL ')
    view.setUint32(12, 20)
    writeAscii(input, 16, 'ftyp')
    writeAscii(input, 20, 'jxl ')
    view.setUint32(32, 0)
    writeAscii(input, 36, 'jxlp')

    expect(() => imageSize(input)).toThrow(/No codestream found/u)
  })
})
