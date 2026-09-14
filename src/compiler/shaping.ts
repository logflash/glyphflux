import { createHash } from 'node:crypto'
import type { Font } from 'opentype.js'
import type { FontMorphCompiledRun, FontMorphShapedGlyph } from '../contracts/font'
import { stableStringify } from '../contracts/stableJson'
import { FontMorphCompilerError } from './error'
import type { FontMorphFontInput } from './fontIdentity'
import type { FontMorphOutlineFont } from './fontParser'

export interface FontMorphShapeRequest {
  text: string
  fontInstanceId: string
  language?: string
  script?: string
  direction?: 'ltr' | 'rtl'
  features?: Record<string, boolean>
}

/** A deterministic text shaper supplied to the SDF compiler. */
export type FontMorphRunShaper = (
  font: FontMorphFontInput,
  request: FontMorphShapeRequest,
) => FontMorphCompiledRun

function stableFeatures(features: Record<string, boolean> | undefined) {
  return Object.fromEntries(
    Object.entries(features ?? {})
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([tag, enabled]) => {
        if (!/^[ -~]{4}$/u.test(tag) || typeof enabled !== 'boolean') {
          throw new FontMorphCompilerError(
            'UNSUPPORTED_SHAPING',
            `shape.features.${tag}`,
            'feature tags contain four ASCII characters and values must be boolean',
          )
        }
        return [tag, enabled]
      }),
  )
}

function defaultScript(text: string, language = 'und') {
  if (/\p{Script=Arabic}/u.test(text)) return 'Arab'
  if (/\p{Script=Armenian}/u.test(text)) return 'Armn'
  if (/\p{Script=Bengali}/u.test(text)) return 'Beng'
  if (/\p{Script=Cyrillic}/u.test(text)) return 'Cyrl'
  if (/\p{Script=Devanagari}/u.test(text)) return 'Deva'
  if (/\p{Script=Ethiopic}/u.test(text)) return 'Ethi'
  if (/\p{Script=Georgian}/u.test(text)) return 'Geor'
  if (/\p{Script=Greek}/u.test(text)) return 'Grek'
  if (/\p{Script=Gujarati}/u.test(text)) return 'Gujr'
  if (/\p{Script=Gurmukhi}/u.test(text)) return 'Guru'
  if (/\p{Script=Hebrew}/u.test(text)) return 'Hebr'
  if (/\p{Script=Hangul}/u.test(text)) return 'Kore'
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(text)) return 'Jpan'
  if (/\p{Script=Kannada}/u.test(text)) return 'Knda'
  if (/\p{Script=Malayalam}/u.test(text)) return 'Mlym'
  if (/\p{Script=Myanmar}/u.test(text)) return 'Mymr'
  if (/\p{Script=Tamil}/u.test(text)) return 'Taml'
  if (/\p{Script=Telugu}/u.test(text)) return 'Telu'
  if (/\p{Script=Thai}/u.test(text)) return 'Thai'
  if (/\p{Script=Han}/u.test(text)) {
    const locale = language.toLowerCase()
    if (locale.startsWith('ja')) return 'Jpan'
    if (locale.startsWith('ko')) return 'Kore'
    if (/^zh-(tw|hk|mo|hant)/u.test(locale)) return 'Hant'
    if (locale.startsWith('zh')) return 'Hans'
    return 'Hani'
  }
  return 'Latn'
}

function defaultDirection(script: string) {
  return ['Arab', 'Hebr', 'Syrc', 'Thaa'].includes(script) ? 'rtl' : 'ltr'
}

function fontkitScript(script: string): string | string[] {
  const normalized = script.toLowerCase()
  const scripts: Record<string, string | string[]> = {
    arab: 'arab',
    armn: 'armn',
    beng: ['bng2', 'beng'],
    cyrl: 'cyrl',
    deva: ['dev2', 'deva'],
    dev2: ['dev2', 'deva'],
    ethi: 'ethi',
    geor: 'geor',
    grek: 'grek',
    gujr: ['gjr2', 'gujr'],
    guru: ['gur2', 'guru'],
    hang: 'hang',
    hani: 'hani',
    hans: 'hani',
    hant: 'hani',
    hebr: 'hebr',
    jpan: ['kana', 'hani'],
    knda: ['knd2', 'knda'],
    kore: ['hang', 'hani'],
    latn: 'latn',
    mlym: ['mlm2', 'mlym'],
    mymr: ['mym2', 'mymr'],
    taml: ['tml2', 'taml'],
    telu: ['tel2', 'telu'],
    thai: 'thai',
  }
  return scripts[normalized] ?? normalized
}

export function resolveFontMorphShapeRequest(request: FontMorphShapeRequest) {
  const language = request.language ?? 'und'
  const script = request.script ?? defaultScript(request.text, language)
  const direction = request.direction ?? defaultDirection(script)
  const features = stableFeatures(request.features)

  return {
    text: request.text,
    fontInstanceId: request.fontInstanceId,
    language,
    script,
    direction,
    features,
  }
}

export function shapeFontMorphRun(
  font: Font,
  request: FontMorphShapeRequest,
): FontMorphCompiledRun {
  const identity = resolveFontMorphShapeRequest(request)
  if (
    identity.direction !== 'ltr' ||
    /\p{Mark}/u.test(identity.text) ||
    Object.values(identity.features).some(Boolean)
  ) {
    throw new FontMorphCompilerError(
      'UNSUPPORTED_SHAPING',
      'shape.text',
      'the opentype.js compatibility shaper supports unmarked left-to-right text only; use shapeFontMorphInstantiatedRun for contextual shaping',
    )
  }

  const unitsPerEm = font.unitsPerEm
  const glyphs: FontMorphShapedGlyph[] = []
  let x = 0
  let previous = null as ReturnType<Font['charToGlyph']> | null
  for (const unicode of request.text) {
    const glyph = font.charToGlyph(unicode)
    if (glyph.index === 0 && unicode !== '\0') {
      throw new FontMorphCompilerError(
        'UNSUPPORTED_SHAPING',
        'shape.text',
        `font does not contain ${JSON.stringify(unicode)}`,
      )
    }
    if (previous) x += font.getKerningValue(previous, glyph) / unitsPerEm
    const advanceWidth = (glyph.advanceWidth ?? unitsPerEm) / unitsPerEm
    glyphs.push({
      key: `glyph-${glyphs.length.toString().padStart(4, '0')}`,
      codePoints: [unicode.codePointAt(0)!],
      unicode,
      glyphId: glyph.index,
      x,
      y: 0,
      advanceWidth,
    })
    x += advanceWidth
    previous = glyph
  }

  return {
    id: `run-${createHash('sha256').update(stableStringify(identity)).digest('hex').slice(0, 16)}`,
    ...identity,
    glyphs,
    advanceWidth: x,
  }
}

/** Shapes with the same variation-aware engine that supplies compiled outlines. */
export function shapeFontMorphInstantiatedRun(
  font: FontMorphOutlineFont,
  request: FontMorphShapeRequest,
): FontMorphCompiledRun {
  const identity = resolveFontMorphShapeRequest(request)
  const run = font.layout(
    request.text,
    { ...identity.features },
    fontkitScript(identity.script),
    identity.language,
    identity.direction,
  )
  if (run.glyphs.length !== run.positions.length) {
    throw new FontMorphCompilerError(
      'UNSUPPORTED_SHAPING',
      'shape.text',
      'the shaping engine returned inconsistent glyph and position counts',
    )
  }
  const unitsPerEm = font.unitsPerEm
  const glyphs: FontMorphShapedGlyph[] = []
  let x = 0
  let y = 0
  for (let index = 0; index < run.glyphs.length; index += 1) {
    const glyph = run.glyphs[index]
    const position = run.positions[index]
    const codePoints = [...(glyph.codePoints ?? [])]
    if (glyph.id === 0 && codePoints.some((codePoint) => codePoint !== 0)) {
      throw new FontMorphCompilerError(
        'UNSUPPORTED_SHAPING',
        'shape.text',
        `font does not contain ${JSON.stringify(String.fromCodePoint(...codePoints))}`,
      )
    }
    glyphs.push({
      key: `glyph-${index.toString().padStart(4, '0')}`,
      codePoints,
      unicode: String.fromCodePoint(...codePoints),
      glyphId: glyph.id,
      x: (x + position.xOffset) / unitsPerEm,
      y: (y + position.yOffset) / unitsPerEm,
      advanceWidth: position.xAdvance / unitsPerEm,
    })
    x += position.xAdvance
    y += position.yAdvance
  }
  const advanceWidth = run.advanceWidth / unitsPerEm
  return {
    id: `run-${createHash('sha256').update(stableStringify(identity)).digest('hex').slice(0, 16)}`,
    ...identity,
    glyphs,
    advanceWidth,
  }
}
