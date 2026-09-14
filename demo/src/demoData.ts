import type { FontMorphPreparedLoadRequest, FontMorphPreparedManifest } from '../../src'
import type {
  FontMorphCompiledRun,
  FontMorphSerializedSdfEndpoint,
  FontMorphSerializedSdfGlyphPair,
  FontMorphShapedGlyph,
} from '../../src/compiler'
import { languages, profiles } from './catalog'

export type ShapedGlyph = FontMorphShapedGlyph
export type ShapedRun = FontMorphCompiledRun
export type SerializedEndpoint = FontMorphSerializedSdfEndpoint
export type SerializedGlyph = FontMorphSerializedSdfGlyphPair

export interface PairData {
  glyphs: Record<string, SerializedGlyph>
}

export interface SampleData {
  label: string
  text: string
  language: string
  sourceLabel: string
  targetLabel: string
  direction: 'ltr' | 'rtl'
  pair: string
  preparedKey: string
  sourceRun: ShapedRun
  targetRun: ShapedRun
}

export interface DemoManifest {
  samples: Record<string, SampleData>
  languageOrder: string[]
  pairIds: string[]
}

let manifestRequest: Promise<DemoManifest> | undefined
const pairRequests = new Map<string, Promise<PairData>>()

export function loadManifest() {
  manifestRequest ??= fetch('/generated/manifest.json').then((response) => {
    if (!response.ok) throw new Error(`Unable to load Glyphflux demo data (${response.status})`)
    return response.json() as Promise<DemoManifest>
  })
  return manifestRequest
}

export function loadPair(profile: string) {
  let request = pairRequests.get(profile)
  if (!request) {
    request = fetch(`/generated/pairs/${profile}.json`).then((response) => {
      if (!response.ok)
        throw new Error(`Unable to load ${profile} distance fields (${response.status})`)
      return response.json() as Promise<PairData>
    })
    pairRequests.set(profile, request)
  }
  return request
}

export async function preparedManifestFor(
  text: string,
  request?: FontMorphPreparedLoadRequest,
): Promise<FontMorphPreparedManifest | undefined> {
  const candidates = languages.filter((language) => language.text === text)
  if (candidates.length === 0) return undefined
  const manifest = await loadManifest()
  const exactCandidates = request
    ? candidates.filter((language) => {
        const preparedKey = manifest.samples[language.code]?.preparedKey
        return preparedKey === request.key || preparedKey === request.reverseKey
      })
    : candidates
  const resolved = await Promise.all(
    (exactCandidates.length > 0 ? exactCandidates : candidates).map(async (language) => ({
      sample: manifest.samples[language.code],
      pair: await loadPair(language.profile),
    })),
  )
  const sdfMorphs = Object.fromEntries(
    resolved.flatMap(({ sample, pair }) =>
      sample
        ? [
            [
              sample.preparedKey,
              {
                sourceRun: sample.sourceRun,
                targetRun: sample.targetRun,
                glyphs: pair.glyphs,
              },
            ],
          ]
        : [],
    ),
  )
  if (Object.keys(sdfMorphs).length === 0) return undefined
  return {
    version: 2,
    outlines: {},
    sdfMorphs,
  }
}

export const profileList = Object.values(profiles)
