import catalogJson from '../catalog.json'
import type { CSSProperties } from 'react'

export interface FontProfile {
  sourceFile: string
  targetFile: string
  sourceFamily: string
  targetFamily: string
  sourceLabel: string
  targetLabel: string
  sourceAxes?: Record<string, number>
  targetAxes?: Record<string, number>
}

export interface DemoLanguage {
  code: string
  language?: string
  label: string
  text: string
  profile: string
  direction: 'ltr' | 'rtl'
}

interface DemoCatalog {
  source: { name: string; url: string; verified: string }
  profiles: Record<string, FontProfile>
  languages: DemoLanguage[]
}

export const catalog = catalogJson as DemoCatalog
export const languages = catalog.languages
export const profiles = catalog.profiles
export const defaultLanguage = languages.find(({ code }) => code === 'en') ?? languages[0]
export const languageCodes = new Set(languages.map(({ code }) => code))

export function languageFor(code: string | undefined) {
  return languages.find((language) => language.code === code) ?? defaultLanguage
}

export function profileFor(language: DemoLanguage) {
  const profile = profiles[language.profile]
  if (!profile) throw new Error(`Unknown Glyphflux font profile: ${language.profile}`)
  return profile
}

const cssString = (value: string) => JSON.stringify(value)

export const fontFaceCss = Object.values(profiles)
  .flatMap((profile) => [
    `@font-face{font-family:${cssString(profile.sourceFamily)};src:url('/fonts/${profile.sourceFile}') format('truetype');font-weight:${profile.sourceAxes?.wght ? '100 900' : '400'};font-display:block;}`,
    `@font-face{font-family:${cssString(profile.targetFamily)};src:url('/fonts/${profile.targetFile}') format('truetype');font-weight:${profile.targetAxes?.wght ? '100 900' : '600'};font-display:block;}`,
  ])
  .filter((rule, index, rules) => rules.indexOf(rule) === index)
  .join('')

export function profileStyle(language: DemoLanguage) {
  const profile = profileFor(language)
  return {
    '--source-font-family': cssString(profile.sourceFamily),
    '--target-font-family': cssString(profile.targetFamily),
    '--font-morph-sans-weight': String(profile.sourceAxes?.wght ?? 400),
    '--font-morph-serif-weight': String(profile.targetAxes?.wght ?? 600),
    '--font-morph-serif-optical-size': String(profile.targetAxes?.opsz ?? 0),
    '--source-font-weight': String(profile.sourceAxes?.wght ?? 400),
    '--target-font-weight': String(profile.targetAxes?.wght ?? 600),
    '--target-optical-size': String(profile.targetAxes?.opsz ?? 0),
  } as CSSProperties
}

export function fontPreloadLinks(code: string) {
  const profile = profileFor(languageFor(code))
  return [profile.sourceFile, profile.targetFile].map((file) => ({
    rel: 'preload' as const,
    href: `/fonts/${file}`,
    as: 'font' as const,
    type: 'font/ttf',
    crossOrigin: 'anonymous' as const,
  }))
}
