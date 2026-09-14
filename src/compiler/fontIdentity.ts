import { createHash } from 'node:crypto'
import type { FontMorphFontInstance } from '../contracts/font'
import { stableStringify } from '../contracts/stableJson'
import { FontMorphCompilerError } from './error'

export interface FontMorphFontInput {
  data: ArrayBuffer | ArrayBufferView
  faceIndex?: number
  axes?: Record<string, number>
}

function bytesOf(data: ArrayBuffer | ArrayBufferView) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

function sortedAxes(axes: Record<string, number> | undefined) {
  return Object.fromEntries(
    Object.entries(axes ?? {})
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([tag, value]) => {
        if (!/^[ -~]{4}$/u.test(tag) || !Number.isFinite(value)) {
          throw new FontMorphCompilerError(
            'INVALID_FONT',
            `font.axes.${tag}`,
            'axis tags contain four ASCII characters and values must be finite',
          )
        }
        return [tag, value]
      }),
  )
}

export function hashFontBytes(data: ArrayBuffer | ArrayBufferView) {
  return createHash('sha256').update(bytesOf(data)).digest('hex')
}

export function createFontInstance(input: FontMorphFontInput): FontMorphFontInstance {
  const sha256 = hashFontBytes(input.data)
  const faceIndex = input.faceIndex ?? 0
  if (!Number.isSafeInteger(faceIndex) || faceIndex < 0) {
    throw new FontMorphCompilerError(
      'INVALID_FONT',
      'font.faceIndex',
      'faceIndex must be a non-negative safe integer',
    )
  }
  const axes = sortedAxes(input.axes)
  const identity = stableStringify({ sha256, faceIndex, axes })
  const suffix = createHash('sha256').update(identity).digest('hex').slice(0, 16)
  return { id: `font-${suffix}`, sha256, faceIndex, axes }
}

export function fontArrayBuffer(data: ArrayBuffer | ArrayBufferView) {
  const bytes = bytesOf(data)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}
