import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  extractFontMorphGlyph,
  extractFontMorphInstantiatedGlyph,
  parseFontMorphFont,
  stableStringify,
} from '../compiler'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function parsed(name: string, axes?: Record<string, number>) {
  const bytes = await readFile(resolve(packageRoot, `demo/public/fonts/${name}`))
  return parseFontMorphFont({
    data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    axes,
  })
}

describe('deterministic glyph outline extraction', () => {
  it.each([
    'ibm-plex-sans-400-outline.ttf',
    'source-serif-4-600-outline.ttf',
  ])('preserves the O counter in %s', async (name) => {
    const { font } = await parsed(name)
    const outline = extractFontMorphGlyph(font, font.charToGlyph('O').index)
    expect(outline.contours.filter(({ kind }) => kind === 'positive')).toHaveLength(1)
    expect(outline.contours.filter(({ kind }) => kind === 'negative')).toHaveLength(1)
    expect(outline.bounds.xMax).toBeGreaterThan(outline.bounds.xMin)
    expect(outline.bounds.yMax).toBeGreaterThan(outline.bounds.yMin)
  })

  it('does not turn Source Serif R overlap construction into a counter', async () => {
    const { font } = await parsed('source-serif-4-600-outline.ttf')
    const outline = extractFontMorphGlyph(font, font.charToGlyph('R').index)
    expect(outline.contours.filter(({ kind }) => kind === 'negative')).toHaveLength(0)
    expect(outline.contours.filter(({ kind }) => kind === 'positive').length).toBeGreaterThan(0)
  })

  it('emits identical normalized geometry on repeated extraction', async () => {
    const { font } = await parsed('noto-serif-jp-600-outline.ttf')
    const glyphId = font.charToGlyph('さ').index
    expect(stableStringify(extractFontMorphGlyph(font, glyphId))).toBe(
      stableStringify(extractFontMorphGlyph(font, glyphId)),
    )
  })

  it('applies variable-font deltas to disconnected contours', async () => {
    const { outlineFont } = await parsed('source-serif-4-600-outline.ttf', { opsz: 60 })
    const outline = extractFontMorphInstantiatedGlyph(outlineFont, 'í'.codePointAt(0)!)
    const accent = outline.contours.find(
      ({ points }) => Math.min(...points.map(([, y]) => y)) > 0.5,
    )
    expect(accent).toBeDefined()
    expect(Math.min(...accent!.points.map(([x]) => x))).toBeCloseTo(0.099, 3)
    expect(Math.max(...accent!.points.map(([x]) => x))).toBeCloseTo(0.281, 3)
    expect(outline.advanceWidth).toBeCloseTo(0.28, 6)
  })
})
