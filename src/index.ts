/// <reference path="./kute.d.ts" />
/// <reference path="./fontkit.d.ts" />

import type { Font, PathCommand, RenderOptions } from 'opentype.js'
import type { FontMorphCompiledRun } from './contracts/font'
import type { FontMorphSdfGlyphPair, FontMorphSerializedSdfGlyphPair } from './contracts/sdf'
import { fontMorphSdfCoverageRamp, renderFontMorphSdfAlphaFrame } from './sdf-runtime'
import { DEFAULT_FONT_MORPH_DURATION_MS, endpointHandoffOpacities } from './timing'

export {
  DEFAULT_FONT_MORPH_DURATION_MS,
  endpointHandoffOpacities,
  FONT_MORPH_ENDPOINT_HANDOFF_MS,
} from './timing'

const DEFAULT_DURATION_MS = DEFAULT_FONT_MORPH_DURATION_MS
const DESTINATION_TIMEOUT_MS = 10_000
const MORPH_VIEWBOX_SIZE = 1_000
const MORPH_PRECISION = 8
// Generated geometry does not receive the same hinting as browser text. Exact
// DOM endpoint layers and the moving renderer share one registered box, but
// only one is visible per frame so the morph never becomes an opacity dissolve.
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
export type FontMorphFontRole = 'sans' | 'serif'
type FontRole = FontMorphFontRole
type Polygon = [number, number][]

export interface FontMorphOutlineInstance {
  role: FontMorphFontRole
  weight: number
  opticalSize: number
  fontFileIndex?: number
}

export interface FontMorphPreparedLoadRequest {
  key: string
  reverseKey: string
  source: FontMorphOutlineInstance
  target: FontMorphOutlineInstance
}

interface FontMorphOutlinePathCommand {
  command: 'moveTo' | 'lineTo' | 'quadraticCurveTo' | 'bezierCurveTo' | 'closePath'
  args: number[]
}

interface FontMorphOutlineGlyph {
  id: number
  codePoints: number[]
  path: { commands: FontMorphOutlinePathCommand[] }
}

interface FontMorphOutlineFont {
  unitsPerEm: number
  getGlyph(glyphId: number, codePoints?: number[]): FontMorphOutlineGlyph
  getVariation(axes: Record<string, number>): FontMorphOutlineFont
  layout(
    text: string,
    features?: Record<string, boolean>,
    script?: string | string[],
    language?: string,
    direction?: 'ltr' | 'rtl',
  ): {
    glyphs: FontMorphOutlineGlyph[]
    positions: {
      xAdvance: number
      yAdvance: number
      xOffset: number
      yOffset: number
    }[]
  }
}
export interface FontMorphConfiguration {
  /** Outline-font URLs, ordered from the primary face to glyph fallbacks. */
  fontFiles: Record<FontMorphFontRole, readonly string[]>
  /** Class placed on the document root while a nested capture viewport is active. */
  recordingClass?: string
  /** Element representing that nested capture viewport. */
  captureSelector?: string
  /** Optional class applied to transient layers and probes for recorder exclusion. */
  transientClass?: string
  /** Maps a computed CSS font-family string to one of the configured faces. */
  resolveFontRole?: (fontFamily: string) => FontMorphFontRole
  /** Selects a specific file within a role when several fonts share glyphs. */
  resolveFontFileIndex?: (fontFamily: string, role: FontMorphFontRole) => number | undefined
  /** Optional stable text identity copied into semantic recording events. */
  resolveTextIdentity?: (element: HTMLElement) => string | undefined
  /**
   * Loads build-generated, viewport-independent correspondence data for a
   * string and font pair. The optional request preserves compatibility with
   * one-argument loaders while allowing exact, lazy selection when the same
   * text exists in more than one font profile. Returned entries are registered
   * globally and reused in either direction.
   */
  loadPreparedOutlines?: (
    text: string,
    request?: FontMorphPreparedLoadRequest,
  ) => Promise<FontMorphPreparedManifest | undefined> | FontMorphPreparedManifest | undefined
  /**
   * Creates the optional compiler worker used when a string is not present in
   * build-generated data. Without one, the backwards-compatible fallback is
   * loaded in a separate main-thread chunk.
   */
  createWorker?: () => Worker
}

function inferFontRole(fontFamily: string): FontMorphFontRole {
  const families = fontFamily.split(',').map((family) =>
    family
      .trim()
      .replace(/^(['"])(.*)\1$/, '$2')
      .toLowerCase(),
  )

  for (const family of families) {
    if (family === 'sans-serif' || /(^|[\s-])sans([\s-]|$)/.test(family)) return 'sans'
    if (family === 'serif' || /(^|[\s-])serif([\s-]|$)/.test(family)) return 'serif'
  }
  return 'sans'
}

const defaultConfiguration: FontMorphConfiguration = {
  fontFiles: { sans: [], serif: [] },
  recordingClass: 'font-morph-recording',
  captureSelector: '[data-font-morph-capture]',
  resolveFontRole: inferFontRole,
}

let configuration = defaultConfiguration

interface PointColor {
  red: number
  green: number
  blue: number
}

interface Rect {
  left: number
  top: number
  width: number
  height: number
}

interface CaptureFrame {
  screen: Rect
  logicalWidth: number
  logicalHeight: number
}

interface GlyphStyle {
  fontRole: FontRole
  fontFileIndex?: number
  fontFamily: string
  fontStyle: string
  fontWeight: string
  fontSizeToHeight: number
  /** Browser alphabetic baseline as a fraction of the endpoint line box. */
  baselineToHeight?: number
  letterSpacingEm: number
  direction: 'ltr' | 'rtl'
  color: PointColor
}

interface RecordedGlyphEndpoint {
  text: string
  translationHash?: string
  /** Coordinates relative to the capture frame, not the host viewport. */
  rect: Rect
  style: GlyphStyle
}

interface GlyphEndpoint extends RecordedGlyphEndpoint {
  element: HTMLElement
  frame: CaptureFrame
  logicalRect: Rect
  outlineInstance: OutlineInstance
}

interface RecordedFontMorph {
  version: 2
  key: string
  /** Time spent showing the stationary source outline before interpolation. */
  leadIn?: number
  duration: number
  /** Replay-only time reserved for reading a visible settled destination. */
  settledTextHold?: number
  source: RecordedGlyphEndpoint
  target: RecordedGlyphEndpoint
}

/** Compact, renderer-independent state emitted once for a recorded transition. */
export type FontMorphRecording = RecordedFontMorph
export type FontMorphRecordingEndpoint = RecordedGlyphEndpoint
export type FontMorphCaptureFrame = CaptureFrame

interface KuteMorphRuntime {
  getInterpolationPoints: (source: string, target: string, precision: number) => [Polygon, Polygon]
  interpolateCoordinates: (
    source: Polygon,
    target: Polygon,
    length: number,
    progress: number,
  ) => Polygon
}

interface OutlineRuntime extends KuteMorphRuntime {
  fonts: Record<FontRole, Font[]>
  outlineFonts: Record<FontRole, FontMorphOutlineFont[]>
}

interface OutlineContour {
  index: number
  path: string
  polygon: Polygon
  winding: number
  depth: number
  parentIndex: number | null
  center: [number, number]
  area: number
  bounds: Rect
}

interface GlyphOutline {
  contours: OutlineContour[]
  bounds: Rect
}

interface OutlineInstance {
  role: FontRole
  weight: number
  opticalSize: number
  fontFileIndex?: number
}

interface FontMetrics {
  unitsPerEm: number
  ascender: number
  descender: number
}

interface ContourTemplate {
  depth: number
  sourcePath: string
  targetPath: string
  source: Polygon
  target: Polygon
}

export interface FontMorphPreparedContour {
  depth: number
  glyphIndex: number
  source: Polygon
  target: Polygon
}

export interface FontMorphPreparedOutline {
  contours: FontMorphPreparedContour[] | null
  sourceFont?: FontMetrics
  targetFont?: FontMetrics
  fallback?: string
}

type NormalizedOutline = FontMorphPreparedOutline

export interface FontMorphPreparedOutlineManifest {
  version: 1
  outlines: Record<string, FontMorphPreparedOutline>
}

export interface FontMorphPreparedSdfMorph {
  sourceRun: FontMorphCompiledRun
  targetRun: FontMorphCompiledRun
  glyphs: Record<string, FontMorphSerializedSdfGlyphPair>
}

export interface FontMorphPreparedSdfManifest {
  version: 2
  outlines: Record<string, FontMorphPreparedOutline>
  sdfMorphs: Record<string, FontMorphPreparedSdfMorph>
}

export type FontMorphPreparedManifest =
  | FontMorphPreparedOutlineManifest
  | FontMorphPreparedSdfManifest

export interface FontMorphCompileRequest {
  text: string
  source: FontMorphOutlineInstance
  target: FontMorphOutlineInstance
}

interface ContourMorph extends ContourTemplate {
  element: SVGPathElement
}

interface PreparedOutline {
  contours: ContourTemplate[] | null
  fallback?: string
}

interface PreparedMorph {
  renderer: 'outline'
  layer: SVGSVGElement
  source: GlyphEndpoint
  target: GlyphEndpoint
  contours: ContourMorph[] | null
  overlayRoot?: HTMLElement
}

interface PreparedSdfData {
  sourceRun: FontMorphCompiledRun
  targetRun: FontMorphCompiledRun
  glyphs: Record<string, FontMorphSdfGlyphPair>
}

interface PreparedSdfMorph {
  renderer: 'sdf'
  layer: HTMLCanvasElement
  source: GlyphEndpoint
  target: GlyphEndpoint
  data: PreparedSdfData
  glyphCanvases: Map<string, HTMLCanvasElement>
  glyphImages: Map<string, ImageData>
  frames: Map<string, Uint8ClampedArray<ArrayBufferLike>>
  overlayRoot?: HTMLElement
}

type RenderedMorph = PreparedMorph | PreparedSdfMorph

interface FontMorphRenderSession {
  readonly element: SVGSVGElement | HTMLCanvasElement
  readonly renderer: RenderedMorph['renderer']
  readonly available: boolean
  readonly source: GlyphEndpoint
  readonly target: GlyphEndpoint
  setEndpoints(source: GlyphEndpoint, target: GlyphEndpoint, refreshGeometry?: boolean): void
  render(geometryProgress: number, outlineProgress?: number, opacity?: number): void
  destroy(): void
}

interface FrameMorphState {
  payload: RecordedFontMorph
  document: Document
  text: string
  session: FontMorphRenderSession
  sawTarget: boolean
  lastProgress: number
  handoffSource: ReplayOpacityOverride | null
  handoffTarget: ReplayOpacityOverride | null
  sourceHandoffElement: HTMLElement | null
  sourceHandoffLayer: HTMLElement | null
  targetHandoffElement: HTMLElement | null
  targetHandoffLayer: HTMLElement | null
  blendRoot: HTMLElement
  hostRoot?: HTMLElement
}

interface ReplayOpacityOverride {
  element: HTMLElement
  opacity: string
  priority: string
}

interface EndpointVisibilityLock {
  opacity: string
  priority: string
  token: object
}

interface ActiveMorph {
  key: string
  source: GlyphEndpoint
  layer: SVGSVGElement | HTMLElement
  startedAt: number
  observer: MutationObserver
  timeout: number
  frame: number | null
  finishing: boolean
  handoffElement: HTMLElement | null
  sourceHandoffLayer: SVGSVGElement | HTMLElement | null
  targetHandoffLayer: HTMLElement | null
  blendRoot: HTMLElement
}

let recordingOutlineCache = new WeakMap<RecordedFontMorph, Map<string, PreparedOutline>>()
const normalizedOutlineCache = new Map<string, NormalizedOutline>()
const preparedSdfCache = new Map<string, PreparedSdfData>()
const browserBaselineCache = new WeakMap<
  HTMLElement,
  { signature: string; baselineToHeight: number }
>()
const syntheticBaselineCache = new WeakMap<Document, Map<string, number>>()
const endpointVisibilityLocks = new WeakMap<HTMLElement, EndpointVisibilityLock>()

export const FONT_MORPH_RECORD_EVENT = 'font-morph:record'
export const FONT_MORPH_EVENT_TAG = 'font-morph'
export const SETTLED_TEXT_HOLD_MS = 500

let activeMorph: ActiveMorph | null = null
let compilerWorker: Worker | null = null
let nextWorkerRequestId = 0
const workerRequests = new Map<
  number,
  {
    resolve: (outline: NormalizedOutline) => void
    reject: (error: unknown) => void
  }
>()
const preparedManifestLoads = new Map<string, Promise<void>>()
const outlinePreparationPromises = new Map<string, Promise<NormalizedOutline>>()
let nextMaskId = 0

/** Configure the two outline-font families used by subsequent preparations. */
export function configureFontMorph(options: FontMorphConfiguration) {
  configuration = {
    fontFiles: {
      sans: [...options.fontFiles.sans],
      serif: [...options.fontFiles.serif],
    },
    recordingClass: options.recordingClass ?? defaultConfiguration.recordingClass,
    captureSelector: options.captureSelector ?? defaultConfiguration.captureSelector,
    transientClass: options.transientClass,
    resolveFontRole: options.resolveFontRole ?? defaultConfiguration.resolveFontRole,
    resolveFontFileIndex: options.resolveFontFileIndex,
    resolveTextIdentity: options.resolveTextIdentity,
    loadPreparedOutlines: options.loadPreparedOutlines,
    createWorker: options.createWorker,
  }
  compilerWorker?.terminate()
  compilerWorker = null
  for (const request of workerRequests.values()) {
    request.reject(new Error('Font morph configuration changed'))
  }
  workerRequests.clear()
  preparedManifestLoads.clear()
  outlinePreparationPromises.clear()
  recordingOutlineCache = new WeakMap()
  normalizedOutlineCache.clear()
  preparedSdfCache.clear()
}

function selectorFor(key: string) {
  return `[data-font-morph="${CSS.escape(key)}"]`
}

function markTransient(element: Element) {
  if (configuration.transientClass) element.classList.add(configuration.transientClass)
}

function findEndpointElement(key: string, except?: HTMLElement, ownerDocument = document) {
  return [...ownerDocument.querySelectorAll<HTMLElement>(selectorFor(key))].find(
    (element) => element !== except && element.isConnected,
  )
}

function createSvgElement<K extends keyof SVGElementTagNameMap>(document: Document, name: K) {
  return document.createElementNS(SVG_NAMESPACE, name)
}

function parseColor(value: string): PointColor {
  const channels = value.match(/[\d.]+/g)?.map(Number)
  return {
    red: channels?.[0] ?? 0,
    green: channels?.[1] ?? 0,
    blue: channels?.[2] ?? 0,
  }
}

function fontRoleFor(fontFamily: string): FontRole {
  return configuration.resolveFontRole?.(fontFamily) ?? 'sans'
}

function captureFrame(ownerDocument: Document): CaptureFrame {
  const ownerWindow = ownerDocument.defaultView
  const viewportWidth = Math.max(
    1,
    ownerWindow?.innerWidth ?? ownerDocument.documentElement.clientWidth,
  )
  const viewportHeight = Math.max(
    1,
    ownerWindow?.innerHeight ?? ownerDocument.documentElement.clientHeight,
  )
  const captureElement = ownerDocument.documentElement.classList.contains(
    configuration.recordingClass!,
  )
    ? ownerDocument.querySelector<HTMLElement>(configuration.captureSelector!)
    : null

  if (captureElement) {
    const bounds = captureElement.getBoundingClientRect()
    if (bounds.width > 0 && bounds.height > 0) {
      return {
        screen: {
          left: bounds.left,
          top: bounds.top,
          width: bounds.width,
          height: bounds.height,
        },
        logicalWidth: Math.max(1, captureElement.clientWidth),
        logicalHeight: Math.max(1, captureElement.clientHeight),
      }
    }
  }

  return {
    screen: { left: 0, top: 0, width: viewportWidth, height: viewportHeight },
    logicalWidth: viewportWidth,
    logicalHeight: viewportHeight,
  }
}

function normalizedRect(bounds: DOMRect, frame: CaptureFrame): Rect {
  return {
    left: (bounds.left - frame.screen.left) / frame.screen.width,
    top: (bounds.top - frame.screen.top) / frame.screen.height,
    width: bounds.width / frame.screen.width,
    height: bounds.height / frame.screen.height,
  }
}

function logicalRect(rect: Rect, frame: CaptureFrame): Rect {
  return {
    left: rect.left * frame.logicalWidth,
    top: rect.top * frame.logicalHeight,
    width: rect.width * frame.logicalWidth,
    height: rect.height * frame.logicalHeight,
  }
}

function browserTextBaseline(
  ownerDocument: Document,
  text: string,
  style: Pick<GlyphStyle, 'fontFamily' | 'fontStyle' | 'fontWeight' | 'direction'>,
  size: number,
  lineHeight: number,
  element?: HTMLElement,
  elementBounds?: DOMRect,
) {
  const bounds = elementBounds ?? element?.getBoundingClientRect()
  if (element && bounds && bounds.height > 0) {
    const signature = [
      text,
      style.fontFamily,
      style.fontStyle,
      style.fontWeight,
      style.direction,
      size,
      lineHeight,
      bounds.height,
      ownerDocument.fonts?.status,
    ].join('|')
    const cached = browserBaselineCache.get(element)
    if (cached?.signature === signature) return cached.baselineToHeight * lineHeight

    const marker = ownerDocument.createElement('i')
    markTransient(marker)
    marker.setAttribute('aria-hidden', 'true')
    marker.style.cssText =
      'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;'
    element.append(marker)
    const markerBounds = marker.getBoundingClientRect()
    const measuredBounds = element.getBoundingClientRect()
    marker.remove()
    // The zero-sized inline marker sits on the exact alphabetic baseline used
    // by this element. Unlike a collapsed Range combined with canvas descent,
    // this stays within one CSS layout engine and therefore remains correct
    // when Android supplies a script-specific fallback face.
    if (
      measuredBounds.height > 0 &&
      Math.abs(measuredBounds.width - bounds.width) < 0.01 &&
      Math.abs(measuredBounds.height - bounds.height) < 0.01
    ) {
      const measured = ((markerBounds.top - bounds.top) * lineHeight) / bounds.height
      if (Number.isFinite(measured)) {
        browserBaselineCache.set(element, {
          signature,
          baselineToHeight: measured / lineHeight,
        })
        return measured
      }
    }
  }

  if (!element && ownerDocument.body) {
    const signature = [
      text,
      style.fontFamily,
      style.fontStyle,
      style.fontWeight,
      style.direction,
      size,
      lineHeight,
      ownerDocument.fonts?.status,
    ].join('|')
    let documentCache = syntheticBaselineCache.get(ownerDocument)
    if (!documentCache) {
      documentCache = new Map()
      syntheticBaselineCache.set(ownerDocument, documentCache)
    }
    const cached = documentCache.get(signature)
    if (cached !== undefined) return cached

    const line = ownerDocument.createElement('span')
    const marker = ownerDocument.createElement('i')
    markTransient(line)
    line.setAttribute('aria-hidden', 'true')
    line.style.cssText =
      'position:fixed;left:-10000px;top:0;display:inline-block;visibility:hidden;margin:0;padding:0;border:0;white-space:pre;font-synthesis:none;'
    line.style.fontFamily = style.fontFamily
    line.style.fontStyle = style.fontStyle
    line.style.fontWeight = style.fontWeight
    line.style.fontSize = `${size}px`
    line.style.lineHeight = `${lineHeight}px`
    line.style.direction = style.direction
    marker.style.cssText =
      'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;'
    line.append(ownerDocument.createTextNode(text), marker)
    ownerDocument.body.append(line)
    const lineBounds = line.getBoundingClientRect()
    const markerBounds = marker.getBoundingClientRect()
    line.remove()
    if (lineBounds.height > 0) {
      const measured = ((markerBounds.top - lineBounds.top) * lineHeight) / lineBounds.height
      if (Number.isFinite(measured)) {
        documentCache.set(signature, measured)
        return measured
      }
    }
  }

  const context = ownerDocument.createElement('canvas').getContext('2d')
  if (!context) return undefined
  context.font = `${style.fontStyle} ${style.fontWeight} ${size}px ${style.fontFamily}`
  context.direction = style.direction
  const metrics = context.measureText(text)
  const ascent = metrics.fontBoundingBoxAscent
  const descent = metrics.fontBoundingBoxDescent
  if (!Number.isFinite(ascent) || !Number.isFinite(descent) || ascent <= 0) return undefined

  // CSS can place a line box on a fractional device-independent pixel. Keep
  // that precision: flooring here creates a visible vertical click when the
  // generated geometry hands the final frame to browser-rendered text.
  return (lineHeight - ascent - descent) / 2 + ascent
}

function captureEndpoint(element: HTMLElement): GlyphEndpoint | null {
  const text = element.textContent?.trim()
  const bounds = element.getBoundingClientRect()
  if (!text || bounds.width <= 0 || bounds.height <= 0) return null

  const ownerWindow = element.ownerDocument.defaultView
  const style = ownerWindow?.getComputedStyle(element) ?? getComputedStyle(element)
  const frame = captureFrame(element.ownerDocument)
  const rect = normalizedRect(bounds, frame)
  const logical = logicalRect(rect, frame)
  const fontSize = Number.parseFloat(style.fontSize) || 16
  const letterSpacing = Number.parseFloat(style.letterSpacing)
  const direction = style.direction === 'rtl' ? 'rtl' : 'ltr'
  const glyphStyle: GlyphStyle = {
    fontRole: fontRoleFor(style.fontFamily),
    fontFamily: style.fontFamily,
    fontStyle: style.fontStyle,
    fontWeight: style.fontWeight,
    fontSizeToHeight: fontSize / logical.height,
    letterSpacingEm: Number.isFinite(letterSpacing) ? letterSpacing / fontSize : 0,
    direction,
    color: parseColor(style.color),
  }
  glyphStyle.fontFileIndex = configuration.resolveFontFileIndex?.(
    style.fontFamily,
    glyphStyle.fontRole,
  )
  const measuredBaseline = browserTextBaseline(
    element.ownerDocument,
    text,
    glyphStyle,
    fontSize,
    logical.height,
    element,
    bounds,
  )
  if (measuredBaseline !== undefined) {
    glyphStyle.baselineToHeight = measuredBaseline / logical.height
  }

  const endpoint: GlyphEndpoint = {
    element,
    frame,
    logicalRect: logical,
    text,
    translationHash: configuration.resolveTextIdentity?.(element),
    rect,
    style: glyphStyle,
    outlineInstance: resolveOutlineInstance(element, glyphStyle, fontSize),
  }
  return endpoint
}

function findMatchingEndpoint(
  ownerDocument: Document,
  key: string,
  expected: RecordedGlyphEndpoint,
  text: string,
  except?: HTMLElement,
) {
  for (const element of ownerDocument.querySelectorAll<HTMLElement>(selectorFor(key))) {
    if (element === except || !element.isConnected) continue
    const endpoint = captureEndpoint(element)
    if (!endpoint || endpoint.style.fontRole !== expected.style.fontRole) continue
    if (endpoint.text !== text) continue
    if (
      expected.translationHash &&
      endpoint.translationHash &&
      endpoint.translationHash !== expected.translationHash
    ) {
      continue
    }
    return endpoint
  }
  return null
}

function endpointFromRecorded(
  recorded: RecordedGlyphEndpoint,
  text: string,
  ownerDocument: Document,
  element: HTMLElement,
  widthRatio = 1,
  frameOverride?: CaptureFrame,
): GlyphEndpoint {
  const frame = frameOverride ?? captureFrame(ownerDocument)
  const rect = { ...recorded.rect, width: recorded.rect.width * widthRatio }
  const logical = logicalRect(rect, frame)
  const style = { ...recorded.style }
  const measuredBaseline = browserTextBaseline(
    ownerDocument,
    text,
    style,
    style.fontSizeToHeight * logical.height,
    logical.height,
  )
  if (measuredBaseline !== undefined) style.baselineToHeight = measuredBaseline / logical.height
  return {
    ...recorded,
    element,
    frame,
    text,
    rect,
    logicalRect: logical,
    style,
    outlineInstance: resolveOutlineInstance(
      element,
      style,
      style.fontSizeToHeight * logical.height,
    ),
  }
}

function recordedEndpoint(endpoint: GlyphEndpoint): RecordedGlyphEndpoint {
  return {
    text: endpoint.text,
    translationHash: endpoint.translationHash,
    rect: endpoint.rect,
    style: endpoint.style,
  }
}

function isInCaptureFrame(rect: Rect) {
  return rect.left + rect.width > 0 && rect.top + rect.height > 0 && rect.left < 1 && rect.top < 1
}

function interpolate(from: number, to: number, progress: number) {
  return from + (to - from) * progress
}

function interpolateRect(source: Rect, target: Rect, progress: number): Rect {
  return {
    left: interpolate(source.left, target.left, progress),
    top: interpolate(source.top, target.top, progress),
    width: interpolate(source.width, target.width, progress),
    height: interpolate(source.height, target.height, progress),
  }
}

// The same ease used by the previous native shared-element transition.
function transitionEase(progress: number) {
  const x1 = 0.22
  const y1 = 1
  const x2 = 0.36
  const y2 = 1
  let parameter = progress

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const inverse = 1 - parameter
    const x =
      3 * inverse * inverse * parameter * x1 +
      3 * inverse * parameter * parameter * x2 +
      parameter ** 3
    const slope =
      3 * inverse * inverse * x1 +
      6 * inverse * parameter * (x2 - x1) +
      3 * parameter * parameter * (1 - x2)
    if (Math.abs(slope) < 1e-6) break
    parameter = Math.min(1, Math.max(0, parameter - (x - progress) / slope))
  }

  const inverse = 1 - parameter
  return (
    3 * inverse * inverse * parameter * y1 +
    3 * inverse * parameter * parameter * y2 +
    parameter ** 3
  )
}

function startEndpointHandoff(morph: ActiveMorph, element: HTMLElement) {
  morph.handoffElement = element
}

function restoreReplayOpacity(override: ReplayOpacityOverride | null) {
  if (!override) return
  const { element, opacity, priority } = override
  if (opacity) element.style.setProperty('opacity', opacity, priority)
  else element.style.removeProperty('opacity')
}

function restoreFrameHandoffs(state: FrameMorphState | null) {
  if (!state) return
  restoreReplayOpacity(state.handoffSource)
  restoreReplayOpacity(state.handoffTarget)
  state.handoffSource = null
  state.handoffTarget = null
}

function setFrameHandoff(
  state: FrameMorphState,
  endpoint: 'source' | 'target',
  element: HTMLElement | null,
  opacity: number,
) {
  const property = endpoint === 'source' ? 'handoffSource' : 'handoffTarget'
  if (state[property]?.element !== element) {
    restoreReplayOpacity(state[property])
    state[property] = null
    if (element) {
      state[property] = {
        element,
        opacity: element.style.getPropertyValue('opacity'),
        priority: element.style.getPropertyPriority('opacity'),
      }
    }
  }
  // Inline !important also overrides the hiding rule embedded in recordings
  // made before the deterministic endpoint handoff was introduced.
  element?.style.setProperty('opacity', String(opacity), 'important')
}

function syncFrameDomHandoff(
  state: FrameMorphState,
  side: 'source' | 'target',
  endpoint: GlyphEndpoint | null,
) {
  const elementProperty = side === 'source' ? 'sourceHandoffElement' : 'targetHandoffElement'
  const layerProperty = side === 'source' ? 'sourceHandoffLayer' : 'targetHandoffLayer'
  if (state[elementProperty] === endpoint?.element && state[layerProperty]?.isConnected) {
    return state[layerProperty]
  }
  state[layerProperty]?.remove()
  state[layerProperty] = null
  state[elementProperty] = endpoint?.element ?? null
  if (!endpoint) return null
  const layer = createInitialDomLayer(endpoint, true, state.blendRoot)
  layer.classList.add(`font-morph-${side}-layer`)
  state[layerProperty] = layer
  return layer
}

function readDuration() {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue('--font-morph-duration')
    .trim()
  const duration = Number.parseFloat(value)
  if (!Number.isFinite(duration)) return DEFAULT_DURATION_MS
  return value.endsWith('s') && !value.endsWith('ms') ? duration * 1000 : duration
}

function fontSize(endpoint: GlyphEndpoint) {
  return endpoint.style.fontSizeToHeight * endpoint.logicalRect.height
}

function numericFontWeight(value: string, fallback: number) {
  const weight = Number.parseFloat(value)
  return Number.isFinite(weight) ? weight : fallback
}

function configuredInstanceValue(element: Element, property: string, fallback: number) {
  const ownerDocument = element.ownerDocument
  const ownerWindow = ownerDocument.defaultView
  const elementStyle = ownerWindow?.getComputedStyle(element)
  const value = Number.parseFloat(elementStyle?.getPropertyValue(property) ?? '')
  return Number.isFinite(value) ? value : fallback
}

function resolveOutlineInstance(
  element: HTMLElement,
  style: GlyphStyle,
  fallbackOpticalSize: number,
): OutlineInstance {
  const role = style.fontRole
  const computedWeight = numericFontWeight(style.fontWeight, role === 'sans' ? 500 : 600)
  return {
    role,
    // The build derives font identities from these authored variables. Some
    // mobile browsers apply accessibility text scaling to computed sizes, so
    // deriving identity from the laid-out size can miss otherwise valid SDF
    // data. Geometry still uses the real measured endpoint box and font size.
    weight: configuredInstanceValue(
      element,
      `--font-morph-${role}-weight`,
      computedWeight,
    ),
    opticalSize:
      role === 'serif'
        ? configuredInstanceValue(
            element,
            '--font-morph-serif-optical-size',
            fallbackOpticalSize,
          )
        : 0,
    ...(style.fontFileIndex === undefined
      ? {}
      : { fontFileIndex: style.fontFileIndex }),
  }
}

function outlineInstance(endpoint: GlyphEndpoint): OutlineInstance {
  return endpoint.outlineInstance
}

function counterpartOutlineInstance(
  role: FontRole,
  referenceElement: HTMLElement,
  fontFileIndex?: number,
): OutlineInstance {
  return {
    role,
    weight: configuredInstanceValue(
      referenceElement,
      `--font-morph-${role}-weight`,
      role === 'sans' ? 500 : 600,
    ),
    opticalSize:
      role === 'serif'
        ? configuredInstanceValue(referenceElement, '--font-morph-serif-optical-size', 23)
        : 0,
    ...(fontFileIndex === undefined ? {} : { fontFileIndex }),
  }
}

function baseline(endpoint: GlyphEndpoint, font?: FontMetrics) {
  const size = fontSize(endpoint)
  const browserBaseline = endpoint.style.baselineToHeight
  if (Number.isFinite(browserBaseline)) return browserBaseline! * endpoint.logicalRect.height
  if (font) {
    const scale = size / font.unitsPerEm
    const ascent = font.ascender * scale
    const descent = Math.abs(font.descender * scale)
    return Math.max(0, endpoint.logicalRect.height - ascent - descent) / 2 + ascent
  }
  return endpoint.logicalRect.height * 0.8
}

function overlayDimension(root: HTMLElement, property: 'width' | 'height') {
  const authored = Number.parseFloat(root.style[property])
  if (Number.isFinite(authored) && authored > 0) return authored
  return Math.max(1, property === 'width' ? root.clientWidth : root.clientHeight)
}

function renderingFrame(
  ownerDocument: Document,
  overlayRoot?: HTMLElement,
  logicalFrame?: CaptureFrame,
): CaptureFrame {
  if (!overlayRoot) return captureFrame(ownerDocument)
  const width = overlayDimension(overlayRoot, 'width')
  const height = overlayDimension(overlayRoot, 'height')
  return {
    screen: { left: 0, top: 0, width, height },
    logicalWidth: logicalFrame?.logicalWidth ?? width,
    logicalHeight: logicalFrame?.logicalHeight ?? height,
  }
}

function createBlendRoot(endpoint: GlyphEndpoint, replay = false, hostRoot?: HTMLElement) {
  const ownerDocument = hostRoot?.ownerDocument ?? endpoint.element.ownerDocument
  const root = ownerDocument.createElement('div')
  root.classList.add('font-morph-blend-root')
  if (!replay) markTransient(root)
  root.setAttribute('aria-hidden', 'true')
  root.style.cssText = `z-index:2147483646;display:block;overflow:visible;pointer-events:none;isolation:isolate;`
  refreshBlendRoot(root, ownerDocument, hostRoot)
  ;(hostRoot ?? ownerDocument.body).append(root)
  return root
}

function refreshBlendRoot(root: HTMLElement, ownerDocument: Document, hostRoot?: HTMLElement) {
  if (hostRoot) {
    root.style.position = 'absolute'
    root.style.inset = '0'
    root.style.removeProperty('width')
    root.style.removeProperty('height')
    return
  }
  const frame = captureFrame(ownerDocument)
  root.style.position = 'fixed'
  root.style.inset = 'auto'
  root.style.left = `${frame.screen.left}px`
  root.style.top = `${frame.screen.top}px`
  root.style.width = `${frame.screen.width}px`
  root.style.height = `${frame.screen.height}px`
}

function setLayerBox(
  layer: SVGSVGElement | HTMLElement,
  rect: Rect,
  ownerDocument: Document,
  overlayRoot?: HTMLElement,
) {
  const frame = renderingFrame(ownerDocument, overlayRoot)
  const screen = {
    left: frame.screen.left + rect.left * frame.screen.width,
    top: frame.screen.top + rect.top * frame.screen.height,
    width: rect.width * frame.screen.width,
    height: rect.height * frame.screen.height,
  }
  layer.style.width = `${screen.width}px`
  layer.style.height = `${screen.height}px`
  layer.style.transform = `translate3d(${screen.left}px, ${screen.top}px, 0)`
}

function setDomHandoffLayerBox(
  layer: SVGSVGElement | HTMLElement,
  endpoint: Rect,
  current: Rect,
  ownerDocument: Document,
  overlayRoot?: HTMLElement,
) {
  const frame = renderingFrame(ownerDocument, overlayRoot)
  const endpointWidth = Math.max(Number.EPSILON, endpoint.width * frame.screen.width)
  const endpointHeight = Math.max(Number.EPSILON, endpoint.height * frame.screen.height)
  const screenLeft = frame.screen.left + current.left * frame.screen.width
  const screenTop = frame.screen.top + current.top * frame.screen.height
  const scaleX = (current.width * frame.screen.width) / endpointWidth
  const scaleY = (current.height * frame.screen.height) / endpointHeight
  // The browser-rendered source remains the exact endpoint glyph, but follows
  // the same interpolated box while it fades into generated geometry. Keeping
  // both layers registered prevents a transient doubled baseline when the
  // destination is far from the source.
  layer.style.width = `${endpointWidth}px`
  layer.style.height = `${endpointHeight}px`
  layer.style.transform = `translate3d(${screenLeft}px, ${screenTop}px, 0) scale(${scaleX}, ${scaleY})`
}

function setLayerColor(layer: SVGSVGElement, color: PointColor) {
  layer.style.color = `rgb(${Math.round(color.red)} ${Math.round(color.green)} ${Math.round(color.blue)})`
}

function smoothColorProgress(progress: number) {
  // Smootherstep keeps the color velocity at zero at both endpoints, so color
  // begins and settles gently while remaining deterministic for replay.
  return progress * progress * progress * (progress * (progress * 6 - 15) + 10)
}

function createTextFallback(layer: SVGSVGElement, endpoint: GlyphEndpoint) {
  const text = createSvgElement(layer.ownerDocument, 'text')
  const size = fontSize(endpoint)
  const height = endpoint.logicalRect.height
  const width = endpoint.logicalRect.width
  const viewboxFontSize = (size / height) * MORPH_VIEWBOX_SIZE
  const horizontalCorrection = height / width

  text.textContent = endpoint.text
  text.setAttribute('x', '0')
  text.setAttribute('y', String((baseline(endpoint) / height) * MORPH_VIEWBOX_SIZE))
  text.setAttribute('fill', 'currentColor')
  text.setAttribute('font-family', endpoint.style.fontFamily)
  text.setAttribute('font-size', String(viewboxFontSize))
  text.setAttribute('font-style', endpoint.style.fontStyle)
  text.setAttribute('font-weight', endpoint.style.fontWeight)
  text.setAttribute('letter-spacing', String(endpoint.style.letterSpacingEm * viewboxFontSize))
  text.setAttribute('transform', `scale(${horizontalCorrection} 1)`)
  text.setAttribute('direction', endpoint.style.direction)
  layer.replaceChildren(text)
}

function createInitialLayer(endpoint: GlyphEndpoint, replay = false, overlayRoot?: HTMLElement) {
  const ownerDocument = overlayRoot?.ownerDocument ?? endpoint.element.ownerDocument
  const layer = createSvgElement(ownerDocument, 'svg')
  layer.classList.add(replay ? 'font-morph-director-layer' : 'font-morph-layer')
  if (!replay) markTransient(layer)
  layer.setAttribute('viewBox', `0 0 ${MORPH_VIEWBOX_SIZE} ${MORPH_VIEWBOX_SIZE}`)
  layer.setAttribute('preserveAspectRatio', 'none')
  layer.setAttribute('aria-hidden', 'true')
  layer.style.cssText += `${overlayRoot ? 'position:absolute' : 'position:fixed'};inset:0 auto auto 0;z-index:2147483646;display:block;overflow:visible;pointer-events:none;transform-origin:top left;mix-blend-mode:plus-lighter;`
  createTextFallback(layer, endpoint)
  setLayerBox(layer, endpoint.rect, endpoint.element.ownerDocument, overlayRoot)
  setLayerColor(layer, endpoint.style.color)
  const renderParent = overlayRoot ?? endpoint.element.ownerDocument.body
  renderParent.append(layer)
  return layer
}

const INITIAL_TEXT_STYLE_PROPERTIES = [
  'color',
  'direction',
  'font-family',
  'font-feature-settings',
  'font-kerning',
  'font-optical-sizing',
  'font-size',
  'font-stretch',
  'font-style',
  'font-synthesis',
  'font-variant-ligatures',
  'font-variation-settings',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-decoration',
  'text-rendering',
  'text-transform',
  'unicode-bidi',
  'word-spacing',
] as const

/**
 * Preserve the browser's exact source glyphs while navigation is pending.
 * An SVG text approximation needs an aspect-ratio correction and visibly
 * compresses on browsers whose mobile text metrics differ from desktop.
 */
function createInitialDomLayer(endpoint: GlyphEndpoint, replay = false, overlayRoot?: HTMLElement) {
  const ownerDocument = overlayRoot?.ownerDocument ?? endpoint.element.ownerDocument
  const ownerWindow = ownerDocument.defaultView
  const computed = ownerWindow?.getComputedStyle(endpoint.element)
  const layer = ownerDocument.createElement('div')
  const textLayer = ownerDocument.createElement('font-morph-text')
  layer.classList.add(replay ? 'font-morph-director-layer' : 'font-morph-layer')
  if (!replay) markTransient(layer)
  layer.dataset.fontMorphRenderer = 'dom'
  layer.setAttribute('aria-hidden', 'true')
  textLayer.textContent = endpoint.text
  layer.style.cssText += `${overlayRoot ? 'position:absolute' : 'position:fixed'};inset:0 auto auto 0;z-index:2147483646;display:block;overflow:visible;pointer-events:none;transform-origin:top left;white-space:pre;mix-blend-mode:plus-lighter;`
  textLayer.style.cssText +=
    'position:absolute;inset:0 auto auto 0;display:block;transform-origin:top left;white-space:pre;'
  if (computed) {
    for (const property of INITIAL_TEXT_STYLE_PROPERTIES) {
      const value = computed.getPropertyValue(property)
      layer.style.setProperty(property, value)
      textLayer.style.setProperty(property, value)
    }
  }
  layer.append(textLayer)
  setLayerBox(layer, endpoint.rect, ownerDocument, overlayRoot)
  const renderParent = overlayRoot ?? ownerDocument.body
  renderParent.append(layer)

  const sourceRange = ownerDocument.createRange()
  const layerRange = ownerDocument.createRange()
  sourceRange.selectNodeContents(endpoint.element)
  layerRange.selectNodeContents(textLayer)
  const sourceTextRect = sourceRange.getBoundingClientRect()
  const layerTextRect = layerRange.getBoundingClientRect()
  const layerRect = layer.getBoundingClientRect()
  if (
    sourceTextRect.width > 0 &&
    sourceTextRect.height > 0 &&
    layerTextRect.width > 0 &&
    layerTextRect.height > 0
  ) {
    const scaleX = sourceTextRect.width / layerTextRect.width
    const scaleY = sourceTextRect.height / layerTextRect.height
    const localLeft = layerTextRect.left - layerRect.left
    const localTop = layerTextRect.top - layerRect.top
    const targetLeft = sourceTextRect.left - layerRect.left
    const targetTop = sourceTextRect.top - layerRect.top
    textLayer.style.transform = `translate3d(${targetLeft - localLeft * scaleX}px, ${targetTop - localTop * scaleY}px, 0) scale(${scaleX}, ${scaleY})`
  }
  return layer
}

function variationCoordinate(font: Font, tag: string, value: number) {
  const axes = (
    font as unknown as {
      tables?: { fvar?: { axes?: { tag: string; minValue: number; maxValue: number }[] } }
    }
  ).tables?.fvar?.axes
  const axis = axes?.find((candidate) => candidate.tag === tag)
  return axis ? Math.min(axis.maxValue, Math.max(axis.minValue, value)) : value
}

function renderOptions(instance: OutlineInstance, font: Font): RenderOptions {
  const variation =
    instance.role === 'sans'
      ? { wght: variationCoordinate(font, 'wght', instance.weight) }
      : { opsz: variationCoordinate(font, 'opsz', instance.opticalSize) }
  return {
    kerning: true,
    letterSpacing: 0,
    features: { liga: false, rlig: false },
    // opentype.js 2 supports variable coordinates, but @types/opentype.js
    // still describes the pre-variable RenderOptions surface.
    variation,
  } as RenderOptions
}

function commandNumber(value: number) {
  return Number(value.toFixed(3))
}

function contourPath(commands: PathCommand[]) {
  return commands
    .map((command) => {
      switch (command.type) {
        case 'M':
        case 'L':
          return `${command.type}${commandNumber(command.x)} ${commandNumber(command.y)}`
        case 'C':
          return `C${commandNumber(command.x1)} ${commandNumber(command.y1)} ${commandNumber(command.x2)} ${commandNumber(command.y2)} ${commandNumber(command.x)} ${commandNumber(command.y)}`
        case 'Q':
          return `Q${commandNumber(command.x1)} ${commandNumber(command.y1)} ${commandNumber(command.x)} ${commandNumber(command.y)}`
        case 'Z':
          return 'Z'
      }
    })
    .join('')
}

function splitContours(commands: PathCommand[]) {
  const contours: PathCommand[][] = []
  let current: PathCommand[] = []
  for (const command of commands) {
    if (command.type === 'M' && current.length) {
      contours.push(current)
      current = []
    }
    current.push(command)
    if (command.type === 'Z') {
      contours.push(current)
      current = []
    }
  }
  if (current.length) contours.push(current)
  return contours.filter((contour) => contour.some((command) => command.type !== 'M'))
}

function contourWinding(commands: PathCommand[]) {
  const points: Polygon = []
  for (const command of commands) {
    if (command.type !== 'Z') points.push([command.x, command.y])
  }
  let doubledArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    doubledArea += current[0] * next[1] - next[0] * current[1]
  }
  return Math.sign(doubledArea) || 1
}

function pointInPolygon(point: [number, number], polygon: Polygon) {
  let inside = false
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const [currentX, currentY] = polygon[current]
    const [previousX, previousY] = polygon[previous]
    const crosses =
      currentY > point[1] !== previousY > point[1] &&
      point[0] <
        ((previousX - currentX) * (point[1] - currentY)) / (previousY - currentY) + currentX
    if (crosses) inside = !inside
  }
  return inside
}

function polygonStats(polygon: Polygon) {
  let doubledArea = 0
  let centerX = 0
  let centerY = 0
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index]
    const next = polygon[(index + 1) % polygon.length]
    const cross = current[0] * next[1] - next[0] * current[1]
    doubledArea += cross
    centerX += (current[0] + next[0]) * cross
    centerY += (current[1] + next[1]) * cross
  }
  const area = Math.abs(doubledArea) / 2
  if (Math.abs(doubledArea) < 1e-6) {
    const sum = polygon.reduce(
      (result, point) => [result[0] + point[0], result[1] + point[1]] as [number, number],
      [0, 0] as [number, number],
    )
    return {
      area,
      center: [sum[0] / polygon.length, sum[1] / polygon.length] as [number, number],
    }
  }
  return {
    area,
    center: [centerX / (3 * doubledArea), centerY / (3 * doubledArea)] as [number, number],
  }
}

function polygonBounds(polygon: Polygon): Rect {
  const horizontal = polygon.map(([x]) => x)
  const vertical = polygon.map(([, y]) => y)
  const left = Math.min(...horizontal)
  const top = Math.min(...vertical)
  return {
    left,
    top,
    width: Math.max(Number.EPSILON, Math.max(...horizontal) - left),
    height: Math.max(Number.EPSILON, Math.max(...vertical) - top),
  }
}

function combinedBounds(contours: OutlineContour[]): Rect {
  if (!contours.length) return { left: 0, top: 0, width: 1, height: 1 }
  const left = Math.min(...contours.map((contour) => contour.bounds.left))
  const top = Math.min(...contours.map((contour) => contour.bounds.top))
  const right = Math.max(...contours.map((contour) => contour.bounds.left + contour.bounds.width))
  const bottom = Math.max(...contours.map((contour) => contour.bounds.top + contour.bounds.height))
  return {
    left,
    top,
    width: Math.max(Number.EPSILON, right - left),
    height: Math.max(Number.EPSILON, bottom - top),
  }
}

function classifyContours(
  inputs: { path: string; winding: number }[],
  runtime: KuteMorphRuntime,
): OutlineContour[] {
  const contours: OutlineContour[] = inputs.map(({ path, winding }, index) => {
    const polygon = runtime.getInterpolationPoints(path, path, MORPH_PRECISION)[0]
    const { area, center } = polygonStats(polygon)
    return {
      index,
      path,
      polygon,
      winding,
      depth: 0,
      parentIndex: null,
      center,
      area,
      bounds: polygonBounds(polygon),
    }
  })

  for (const contour of contours) {
    const sample = contour.polygon[0]
    const containers = contours
      .filter(
        (candidate) =>
          candidate !== contour &&
          candidate.area > contour.area &&
          candidate.winding !== contour.winding &&
          pointInPolygon(sample, candidate.polygon),
      )
      .sort((left, right) => left.area - right.area)
    contour.parentIndex = containers[0]?.index ?? null
  }
  const contourDepth = (contour: OutlineContour): number => {
    if (contour.parentIndex === null) return 0
    const parent = contours[contour.parentIndex]
    return parent ? contourDepth(parent) + 1 : 0
  }
  for (const contour of contours) contour.depth = contourDepth(contour)
  return contours
}

function outlineFontIndex(text: string, fonts: readonly Font[], preferredIndex?: number) {
  const characters = [...text]
  if (
    preferredIndex !== undefined &&
    Number.isSafeInteger(preferredIndex) &&
    preferredIndex >= 0 &&
    preferredIndex < fonts.length &&
    characters.every((character) => fonts[preferredIndex].hasChar(character))
  ) {
    return preferredIndex
  }
  return fonts.findIndex((candidate) =>
    characters.every((character) => candidate.hasChar(character)),
  )
}

function fontMetrics(font: Font): FontMetrics {
  return {
    unitsPerEm: font.unitsPerEm,
    ascender: font.ascender,
    descender: font.descender,
  }
}

function buildOutline(
  text: string,
  font: Font,
  outlineFont: FontMorphOutlineFont,
  instance: OutlineInstance,
  runtime: KuteMorphRuntime,
): GlyphOutline[] {
  // Build once in a common 1,000-unit em square. Endpoint size, line box, and
  // letter spacing are cheap affine transforms applied only after navigation
  // reveals the target.
  const canonicalBaseline = (font.ascender / font.unitsPerEm) * MORPH_VIEWBOX_SIZE
  const variation =
    (
      renderOptions(instance, font) as RenderOptions & {
        variation?: Record<string, number>
      }
    ).variation ?? {}
  let variableFont = outlineFont
  if (Object.keys(variation).length) {
    try {
      variableFont = outlineFont.getVariation(variation)
    } catch {
      // Static fallback faces share the same semantic role but have no fvar
      // table. Their sole outline is already the requested font instance.
    }
  }
  // Use the shaping engine's script defaults. Required Arabic joining,
  // Devanagari conjuncts, and mark positioning must match live browser text.
  const run = variableFont.layout(text)
  const scale = MORPH_VIEWBOX_SIZE / variableFont.unitsPerEm
  let runX = 0
  let runY = 0
  const paths = run.glyphs.map((glyph, index) => {
    const position = run.positions[index]
    const offsetX = runX + position.xOffset
    const offsetY = runY + position.yOffset
    const commands = glyph.path.commands.map((command) =>
      positionedFontkitCommand(command, scale, canonicalBaseline, offsetX, offsetY),
    )
    runX += position.xAdvance
    runY += position.yAdvance
    return { commands }
  })
  return paths.map((path) => {
    const contours = splitContours(path.commands).map((commands) => ({
      path: contourPath(commands),
      winding: contourWinding(commands),
    }))
    const classified = classifyContours(contours, runtime)
    return { contours: classified, bounds: combinedBounds(classified) }
  })
}

function positionedFontkitCommand(
  command: FontMorphOutlinePathCommand,
  scale: number,
  baseline: number,
  offsetX: number,
  offsetY: number,
): PathCommand {
  const x = (value: number) => (offsetX + value) * scale
  const y = (value: number) => baseline - (offsetY + value) * scale
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = command.args
  switch (command.command) {
    case 'moveTo':
      return { type: 'M', x: x(x1), y: y(y1) }
    case 'lineTo':
      return { type: 'L', x: x(x1), y: y(y1) }
    case 'quadraticCurveTo':
      return { type: 'Q', x1: x(x1), y1: y(y1), x: x(x2), y: y(y2) }
    case 'bezierCurveTo':
      return {
        type: 'C',
        x1: x(x1),
        y1: y(y1),
        x2: x(x2),
        y2: y(y2),
        x: x(x3),
        y: y(y3),
      }
    case 'closePath':
      return { type: 'Z' }
  }
}

function relativeContourMetrics(contour: OutlineContour, glyph: GlyphOutline) {
  const glyphArea = glyph.bounds.width * glyph.bounds.height
  return {
    center: [
      (contour.center[0] - glyph.bounds.left) / glyph.bounds.width,
      (contour.center[1] - glyph.bounds.top) / glyph.bounds.height,
    ] as [number, number],
    width: contour.bounds.width / glyph.bounds.width,
    height: contour.bounds.height / glyph.bounds.height,
    area: contour.area / glyphArea,
  }
}

function contourPairCost(
  source: OutlineContour,
  target: OutlineContour,
  sourceGlyph: GlyphOutline,
  targetGlyph: GlyphOutline,
) {
  const sourceMetrics = relativeContourMetrics(source, sourceGlyph)
  const targetMetrics = relativeContourMetrics(target, targetGlyph)
  const centerDistance = Math.hypot(
    sourceMetrics.center[0] - targetMetrics.center[0],
    sourceMetrics.center[1] - targetMetrics.center[1],
  )
  const areaDistance = Math.abs(
    Math.log((sourceMetrics.area + Number.EPSILON) / (targetMetrics.area + Number.EPSILON)),
  )
  const sizeDistance =
    Math.abs(sourceMetrics.width - targetMetrics.width) +
    Math.abs(sourceMetrics.height - targetMetrics.height)
  const sourceChildren = sourceGlyph.contours.filter(
    (contour) => contour.parentIndex === source.index,
  ).length
  const targetChildren = targetGlyph.contours.filter(
    (contour) => contour.parentIndex === target.index,
  ).length
  return (
    centerDistance * 400 +
    areaDistance * 80 +
    sizeDistance * 120 +
    Math.abs(sourceChildren - targetChildren) * 160
  )
}

/** Minimum-cost one-to-one assignment. Dummy rows or columns select which
 * unmatched components should collapse without disturbing the other strokes. */
function minimumAssignment(costs: number[][]) {
  const size = costs.length
  if (!size) return []
  const rowPotential = new Array<number>(size + 1).fill(0)
  const columnPotential = new Array<number>(size + 1).fill(0)
  const columnMatch = new Array<number>(size + 1).fill(0)
  const predecessor = new Array<number>(size + 1).fill(0)

  for (let row = 1; row <= size; row += 1) {
    columnMatch[0] = row
    let column = 0
    const minimum = new Array<number>(size + 1).fill(Number.POSITIVE_INFINITY)
    const visited = new Array<boolean>(size + 1).fill(false)
    do {
      visited[column] = true
      const matchedRow = columnMatch[column]
      let delta = Number.POSITIVE_INFINITY
      let nextColumn = 0
      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (visited[candidate]) continue
        const reducedCost =
          costs[matchedRow - 1][candidate - 1] -
          rowPotential[matchedRow] -
          columnPotential[candidate]
        if (reducedCost < minimum[candidate]) {
          minimum[candidate] = reducedCost
          predecessor[candidate] = column
        }
        if (minimum[candidate] < delta) {
          delta = minimum[candidate]
          nextColumn = candidate
        }
      }
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (visited[candidate]) {
          rowPotential[columnMatch[candidate]] += delta
          columnPotential[candidate] -= delta
        } else {
          minimum[candidate] -= delta
        }
      }
      column = nextColumn
    } while (columnMatch[column] !== 0)

    do {
      const previousColumn = predecessor[column]
      columnMatch[column] = columnMatch[previousColumn]
      column = previousColumn
    } while (column !== 0)
  }

  const assignment = new Array<number>(size).fill(-1)
  for (let column = 1; column <= size; column += 1) {
    if (columnMatch[column]) assignment[columnMatch[column] - 1] = column - 1
  }
  return assignment
}

function squaredDistance(left: [number, number], right: [number, number]) {
  return (left[0] - right[0]) ** 2 + (left[1] - right[1]) ** 2
}

function closestBoundaryPoint(reference: OutlineContour, addition: OutlineContour) {
  let closest = reference.polygon[0]
  let minimumDistance = Number.POSITIVE_INFINITY
  for (const referencePoint of reference.polygon) {
    for (const additionPoint of addition.polygon) {
      const distance = squaredDistance(referencePoint, additionPoint)
      if (distance < minimumDistance) {
        minimumDistance = distance
        closest = referencePoint
      }
    }
  }
  return { point: closest, distance: minimumDistance }
}

function mapGlyphPoint(point: [number, number], from: GlyphOutline, to: GlyphOutline) {
  return [
    to.bounds.left + ((point[0] - from.bounds.left) / from.bounds.width) * to.bounds.width,
    to.bounds.top + ((point[1] - from.bounds.top) / from.bounds.height) * to.bounds.height,
  ] as [number, number]
}

function nearestPoint(contour: OutlineContour, point: [number, number]) {
  return contour.polygon.reduce(
    (closest, candidate) =>
      squaredDistance(candidate, point) < squaredDistance(closest, point) ? candidate : closest,
    contour.polygon[0],
  )
}

function pairGlyphContours(source: GlyphOutline, target: GlyphOutline) {
  const pairs: [OutlineContour, OutlineContour][] = []

  const collapseSubtree = (
    glyph: GlyphOutline,
    contour: OutlineContour,
    side: 'source' | 'target',
    anchor: [number, number],
  ) => {
    if (side === 'source') pairs.push([contour, collapsedContour(contour, anchor)])
    else pairs.push([collapsedContour(contour, anchor), contour])
    for (const child of glyph.contours.filter(
      (candidate) => candidate.parentIndex === contour.index,
    )) {
      collapseSubtree(glyph, child, side, anchor)
    }
  }

  const attachmentAnchor = (
    contour: OutlineContour,
    side: 'source' | 'target',
    matched: [OutlineContour, OutlineContour][],
  ) => {
    if (!matched.length) {
      const from = side === 'source' ? source : target
      const to = side === 'source' ? target : source
      return mapGlyphPoint(contour.center, from, to)
    }
    const related = matched.reduce(
      (best, candidate) => {
        const reference = side === 'source' ? candidate[0] : candidate[1]
        const distance = closestBoundaryPoint(reference, contour).distance
        return distance < best.distance ? { pair: candidate, distance } : best
      },
      { pair: matched[0], distance: Number.POSITIVE_INFINITY },
    ).pair
    const reference = side === 'source' ? related[0] : related[1]
    const counterpart = side === 'source' ? related[1] : related[0]
    const fromGlyph = side === 'source' ? source : target
    const toGlyph = side === 'source' ? target : source
    const attachment = closestBoundaryPoint(reference, contour).point
    return nearestPoint(counterpart, mapGlyphPoint(attachment, fromGlyph, toGlyph))
  }

  const pairChildren = (
    sourceParent: number | null,
    targetParent: number | null,
    parentPair?: [OutlineContour, OutlineContour],
  ) => {
    const sourceChildren = source.contours.filter((contour) => contour.parentIndex === sourceParent)
    const targetChildren = target.contours.filter((contour) => contour.parentIndex === targetParent)
    const size = Math.max(sourceChildren.length, targetChildren.length)
    if (!size) return
    const costs = Array.from({ length: size }, (_, sourceIndex) =>
      Array.from({ length: size }, (_, targetIndex) => {
        const sourceContour = sourceChildren[sourceIndex]
        const targetContour = targetChildren[targetIndex]
        return sourceContour && targetContour
          ? contourPairCost(sourceContour, targetContour, source, target)
          : 0
      }),
    )

    const matched: [OutlineContour, OutlineContour][] = []
    const unmatchedSource: OutlineContour[] = []
    const unmatchedTarget: OutlineContour[] = []
    for (const [sourceIndex, targetIndex] of minimumAssignment(costs).entries()) {
      const sourceContour = sourceChildren[sourceIndex]
      const targetContour = targetChildren[targetIndex]
      if (sourceContour && targetContour) {
        matched.push([sourceContour, targetContour])
      } else if (sourceContour) {
        unmatchedSource.push(sourceContour)
      } else if (targetContour) {
        unmatchedTarget.push(targetContour)
      }
    }
    const attachmentPairs = matched.length ? matched : parentPair ? [parentPair] : []
    for (const pair of matched) {
      pairs.push(pair)
      pairChildren(pair[0].index, pair[1].index, pair)
    }
    for (const contour of unmatchedSource) {
      collapseSubtree(
        source,
        contour,
        'source',
        attachmentAnchor(contour, 'source', attachmentPairs),
      )
    }
    for (const contour of unmatchedTarget) {
      collapseSubtree(
        target,
        contour,
        'target',
        attachmentAnchor(contour, 'target', attachmentPairs),
      )
    }
  }

  // Pair connected components first, then recurse only within their owned
  // counters. A hole can no longer migrate into another stroke of the glyph.
  pairChildren(null, null)
  return pairs
}

function collapsedContour(contour: OutlineContour, anchor = contour.center): OutlineContour {
  const [x, y] = anchor
  const radius = 0.001
  const polygon: Polygon = [
    [x - radius, y],
    [x, y - radius],
    [x + radius, y],
    [x, y + radius],
  ]
  return {
    ...contour,
    path: polygonPath(polygon),
    polygon,
    center: anchor,
    area: 0,
    bounds: polygonBounds(polygon),
  }
}

interface BoundaryFeature {
  x: number
  y: number
  tangentX: number
  tangentY: number
}

function boundaryFeatures(polygon: Polygon): BoundaryFeature[] {
  const bounds = polygonBounds(polygon)
  const normalized = polygon.map(
    ([x, y]) =>
      [(x - bounds.left) / bounds.width, (y - bounds.top) / bounds.height] as [number, number],
  )
  return normalized.map(([x, y], index) => {
    const previous = normalized[(index + normalized.length - 1) % normalized.length]
    const next = normalized[(index + 1) % normalized.length]
    const tangentX = next[0] - previous[0]
    const tangentY = next[1] - previous[1]
    const tangentLength = Math.max(Number.EPSILON, Math.hypot(tangentX, tangentY))
    return {
      x,
      y,
      tangentX: tangentX / tangentLength,
      tangentY: tangentY / tangentLength,
    }
  })
}

function boundaryPairCost(
  source: BoundaryFeature,
  target: BoundaryFeature,
  sourceIndex: number,
  targetIndex: number,
  band: number,
) {
  const position = (source.x - target.x) ** 2 + (source.y - target.y) ** 2
  const tangent =
    1 -
    Math.max(-1, Math.min(1, source.tangentX * target.tangentX + source.tangentY * target.tangentY))
  const phase = ((sourceIndex - targetIndex) / band) ** 2
  return position + tangent * 0.2 + phase * 0.15
}

function pointAlongBoundary(polygon: Polygon, index: number): [number, number] {
  const wrapped = ((index % polygon.length) + polygon.length) % polygon.length
  const startIndex = Math.floor(wrapped)
  const progress = wrapped - startIndex
  const start = polygon[startIndex]
  const end = polygon[(startIndex + 1) % polygon.length]
  return [interpolate(start[0], end[0], progress), interpolate(start[1], end[1], progress)]
}

function sectionedBoundaryCorrespondence(
  source: Polygon,
  target: Polygon,
  warpingPath: [number, number][],
): [Polygon, Polygon] {
  const length = source.length
  // The DTW path discovers local structural correspondence. Convert that path
  // into strictly ordered section anchors, then resample every section. This
  // keeps the useful local match without leaving duplicated points that can
  // pinch into visible blobs halfway through the morph.
  const landmarkSpacing = Math.max(3, Math.ceil(length / 24))
  const sourceLandmarks: number[] = []
  for (let index = 0; index < length; index += landmarkSpacing) sourceLandmarks.push(index)
  sourceLandmarks.push(length)

  const targetLandmarks = sourceLandmarks.map((sourceIndex) => {
    if (sourceIndex === length) return length
    const candidates = warpingPath.filter(([candidate]) => candidate === sourceIndex)
    if (candidates.length) {
      return Math.round(
        candidates.reduce((sum, [, targetIndex]) => sum + targetIndex, 0) / candidates.length,
      )
    }
    return sourceIndex
  })
  targetLandmarks[0] = 0
  targetLandmarks[targetLandmarks.length - 1] = length
  for (let index = 1; index < targetLandmarks.length - 1; index += 1) {
    const remaining = targetLandmarks.length - 1 - index
    targetLandmarks[index] = Math.min(
      length - remaining,
      Math.max(targetLandmarks[index - 1] + 1, targetLandmarks[index]),
    )
  }

  const matchedSource: Polygon = []
  const matchedTarget: Polygon = []
  for (let section = 0; section < sourceLandmarks.length - 1; section += 1) {
    const sourceStart = sourceLandmarks[section]
    const sourceEnd = sourceLandmarks[section + 1]
    const targetStart = targetLandmarks[section]
    const targetEnd = targetLandmarks[section + 1]
    const segmentCount = Math.max(sourceEnd - sourceStart, targetEnd - targetStart)
    for (let segment = 0; segment < segmentCount; segment += 1) {
      const sectionProgress = segment / segmentCount
      matchedSource.push(
        pointAlongBoundary(source, interpolate(sourceStart, sourceEnd, sectionProgress)),
      )
      matchedTarget.push(
        pointAlongBoundary(target, interpolate(targetStart, targetEnd, sectionProgress)),
      )
    }
  }
  return [matchedSource, matchedTarget]
}

/**
 * Refine KUTE's single cyclic contour match with a banded, monotonic boundary
 * assignment. Repeated points are harmless at either endpoint, while the
 * ordering guarantee prevents one stroke region from donating its outline to
 * a distant region of the same contour.
 */
function localBoundaryCorrespondence(source: Polygon, target: Polygon): [Polygon, Polygon] {
  if (source.length !== target.length || source.length < 4) return [source, target]
  const length = source.length
  const band = Math.max(3, Math.ceil(length * 0.08))
  const sourceFeatures = boundaryFeatures(source)
  const targetFeatures = boundaryFeatures(target)
  const directions = new Uint8Array(length * length)
  let previous = new Float64Array(length)
  previous.fill(Number.POSITIVE_INFINITY)

  for (let sourceIndex = 0; sourceIndex < length; sourceIndex += 1) {
    const current = new Float64Array(length)
    current.fill(Number.POSITIVE_INFINITY)
    const firstTarget = Math.max(0, sourceIndex - band)
    const lastTarget = Math.min(length - 1, sourceIndex + band)
    for (let targetIndex = firstTarget; targetIndex <= lastTarget; targetIndex += 1) {
      const pointCost = boundaryPairCost(
        sourceFeatures[sourceIndex],
        targetFeatures[targetIndex],
        sourceIndex,
        targetIndex,
        band,
      )
      if (sourceIndex === 0 && targetIndex === 0) {
        current[targetIndex] = pointCost
        continue
      }

      let predecessorCost = Number.POSITIVE_INFINITY
      let direction = 0
      if (sourceIndex > 0 && targetIndex > 0 && previous[targetIndex - 1] < predecessorCost) {
        predecessorCost = previous[targetIndex - 1]
        direction = 1
      }
      // Advancing only one boundary duplicates a point. Charge a small cost so
      // a local mismatch can flex without allowing long stretches to collapse.
      if (sourceIndex > 0 && previous[targetIndex] + 0.04 < predecessorCost) {
        predecessorCost = previous[targetIndex] + 0.04
        direction = 2
      }
      if (targetIndex > 0 && current[targetIndex - 1] + 0.04 < predecessorCost) {
        predecessorCost = current[targetIndex - 1] + 0.04
        direction = 3
      }
      if (direction) {
        current[targetIndex] = pointCost + predecessorCost
        directions[sourceIndex * length + targetIndex] = direction
      }
    }
    previous = current
  }

  if (!Number.isFinite(previous[length - 1])) return [source, target]
  const warpingPath: [number, number][] = []
  let sourceIndex = length - 1
  let targetIndex = length - 1
  while (true) {
    warpingPath.push([sourceIndex, targetIndex])
    if (sourceIndex === 0 && targetIndex === 0) break
    const direction = directions[sourceIndex * length + targetIndex]
    if (direction === 1) {
      sourceIndex -= 1
      targetIndex -= 1
    } else if (direction === 2) {
      sourceIndex -= 1
    } else if (direction === 3) {
      targetIndex -= 1
    } else {
      return [source, target]
    }
  }
  warpingPath.reverse()
  return sectionedBoundaryCorrespondence(source, target, warpingPath)
}

async function createOutlineRuntime(
  fontBuffers: Record<FontRole, readonly ArrayBuffer[]>,
): Promise<OutlineRuntime> {
  const [opentype, kuteSvgMorph, fontkit] = await Promise.all([
    import('opentype.js'),
    import('kute.js/dist/kute.esm.js'),
    import('fontkit'),
  ])
  const opentypeModule = opentype as unknown as {
    parse?: (buffer: ArrayBuffer) => Font
    default?: { parse?: (buffer: ArrayBuffer) => Font }
  }
  const parseFont = opentypeModule.parse ?? opentypeModule.default?.parse
  if (!parseFont) throw new Error('opentype.js does not expose its parser')
  const fontkitModule = fontkit as unknown as {
    create?: (buffer: Uint8Array) => FontMorphOutlineFont
    default?: { create?: (buffer: Uint8Array) => FontMorphOutlineFont }
  }
  const createFont = fontkitModule.create ?? fontkitModule.default?.create
  if (!createFont) throw new Error('fontkit does not expose its parser')
  return {
    fonts: Object.fromEntries(
      Object.entries(fontBuffers).map(([role, buffers]) => [
        role,
        buffers.map((buffer) => parseFont(buffer)),
      ]),
    ) as Record<FontRole, Font[]>,
    outlineFonts: Object.fromEntries(
      Object.entries(fontBuffers).map(([role, buffers]) => [
        role,
        buffers.map((buffer) => createFont(new Uint8Array(buffer))),
      ]),
    ) as Record<FontRole, FontMorphOutlineFont[]>,
    getInterpolationPoints: kuteSvgMorph.default.Util.getInterpolationPoints,
    interpolateCoordinates,
  }
}

function outlineCacheKey(
  text: string,
  sourceInstance: FontMorphOutlineInstance,
  targetInstance: FontMorphOutlineInstance,
) {
  const canonical = (instance: FontMorphOutlineInstance) => ({
    role: instance.role,
    weight: commandNumber(instance.weight),
    // Recorded normalized rectangles reconstruct CSS font sizes with tiny
    // subpixel error (23px can become 23.004492...). Variable-font optical
    // sizes remain meaningfully distinct at tenths while build-time and replay
    // identities converge on the same prepared outline.
    opticalSize: Math.round(instance.opticalSize * 10) / 10,
    ...(instance.fontFileIndex === undefined ? {} : { fontFileIndex: instance.fontFileIndex }),
  })
  return JSON.stringify([text, canonical(sourceInstance), canonical(targetInstance)])
}

/** Stable build/runtime identity for one text and pair of font instances. */
export function fontMorphPreparedKey(
  text: string,
  source: FontMorphOutlineInstance,
  target: FontMorphOutlineInstance,
) {
  return outlineCacheKey(text, source, target)
}

function normalizedOutline(
  text: string,
  sourceInstance: OutlineInstance,
  targetInstance: OutlineInstance,
  runtime: OutlineRuntime,
  cache = normalizedOutlineCache,
): NormalizedOutline {
  const cacheKey = outlineCacheKey(text, sourceInstance, targetInstance)
  const cached = cache.get(cacheKey)
  if (cached) return cached

  const reverseKey = outlineCacheKey(text, targetInstance, sourceInstance)
  const reverse = cache.get(reverseKey)
  if (reverse?.contours && reverse.sourceFont && reverse.targetFont) {
    const normalized: NormalizedOutline = {
      sourceFont: reverse.targetFont,
      targetFont: reverse.sourceFont,
      contours: reverse.contours.map((contour) => ({
        depth: contour.depth,
        glyphIndex: contour.glyphIndex,
        source: contour.target,
        target: contour.source,
      })),
    }
    cache.set(cacheKey, normalized)
    return normalized
  }

  const sourceFontIndex = outlineFontIndex(
    text,
    runtime.fonts[sourceInstance.role],
    sourceInstance.fontFileIndex,
  )
  const targetFontIndex = outlineFontIndex(
    text,
    runtime.fonts[targetInstance.role],
    targetInstance.fontFileIndex,
  )
  if (sourceFontIndex < 0 || targetFontIndex < 0) {
    const normalized: NormalizedOutline = {
      contours: null,
      fallback: 'unsupported-glyph',
    }
    cache.set(cacheKey, normalized)
    return normalized
  }

  const sourceFont = runtime.fonts[sourceInstance.role][sourceFontIndex]
  const targetFont = runtime.fonts[targetInstance.role][targetFontIndex]

  const sourceGlyphs = buildOutline(
    text,
    sourceFont,
    runtime.outlineFonts[sourceInstance.role][sourceFontIndex],
    sourceInstance,
    runtime,
  )
  const targetGlyphs = buildOutline(
    text,
    targetFont,
    runtime.outlineFonts[targetInstance.role][targetFontIndex],
    targetInstance,
    runtime,
  )
  if (sourceGlyphs.length !== targetGlyphs.length) {
    const normalized: NormalizedOutline = {
      contours: null,
      sourceFont: fontMetrics(sourceFont),
      targetFont: fontMetrics(targetFont),
      fallback: 'glyph-count',
    }
    cache.set(cacheKey, normalized)
    return normalized
  }

  const contours: FontMorphPreparedContour[] = []
  for (let glyphIndex = 0; glyphIndex < sourceGlyphs.length; glyphIndex += 1) {
    for (const [sourceContour, targetContour] of pairGlyphContours(
      sourceGlyphs[glyphIndex],
      targetGlyphs[glyphIndex],
    )) {
      // This is KUTE's expensive topology normalization and point matching.
      // It deliberately happens in canonical font space so it can be cached
      // before navigation, independently of the destination viewport/layout.
      const kutePoints = runtime.getInterpolationPoints(
        sourceContour.path,
        targetContour.path,
        MORPH_PRECISION,
      )
      const [sourcePoints, targetPoints] = localBoundaryCorrespondence(...kutePoints)
      contours.push({
        depth: sourceContour.depth,
        glyphIndex,
        source: sourcePoints,
        target: targetPoints,
      })
    }
  }
  contours.sort((a, b) => a.depth - b.depth)

  const normalized = {
    contours,
    sourceFont: fontMetrics(sourceFont),
    targetFont: fontMetrics(targetFont),
  }
  cache.set(cacheKey, normalized)
  return normalized
}

function roundedOutline(outline: NormalizedOutline): NormalizedOutline {
  return {
    ...outline,
    contours:
      outline.contours?.map((contour) => ({
        ...contour,
        source: contour.source.map(([x, y]) => [commandNumber(x), commandNumber(y)]),
        target: contour.target.map(([x, y]) => [commandNumber(x), commandNumber(y)]),
      })) ?? null,
  }
}

/**
 * Node/worker compiler used by build tools and dynamic-text fallbacks. Its
 * output contains no DOM coordinates and can be serialized directly.
 */
export async function createFontMorphCompiler(
  fontBuffers: Record<FontMorphFontRole, readonly ArrayBuffer[]>,
) {
  const runtime = await createOutlineRuntime(fontBuffers)
  // Compiler instances may intentionally cover different fallback subsets
  // (for example Latin first, then CJK). Keep their negative glyph results
  // isolated so a primary-font miss cannot poison a full-stack retry.
  const compilerCache = new Map<string, NormalizedOutline>()
  return (requests: readonly FontMorphCompileRequest[]): FontMorphPreparedOutlineManifest => {
    const outlines: Record<string, FontMorphPreparedOutline> = {}
    for (const request of requests) {
      const source = { ...request.source }
      const target = { ...request.target }
      const key = outlineCacheKey(request.text, source, target)
      outlines[key] = roundedOutline(
        normalizedOutline(request.text, source, target, runtime, compilerCache),
      )
    }
    return { version: 1, outlines }
  }
}

export async function compileFontMorphManifest(
  fontBuffers: Record<FontMorphFontRole, readonly ArrayBuffer[]>,
  requests: readonly FontMorphCompileRequest[],
): Promise<FontMorphPreparedOutlineManifest> {
  const compile = await createFontMorphCompiler(fontBuffers)
  return compile(requests)
}

function reverseNormalizedOutline(outline: NormalizedOutline): NormalizedOutline | undefined {
  if (!outline.contours || !outline.sourceFont || !outline.targetFont) return undefined
  return {
    sourceFont: outline.targetFont,
    targetFont: outline.sourceFont,
    contours: outline.contours.map((contour) => ({
      depth: contour.depth,
      glyphIndex: contour.glyphIndex,
      source: contour.target,
      target: contour.source,
    })),
  }
}

function cachedNormalizedOutline(
  text: string,
  source: OutlineInstance,
  target: OutlineInstance,
): NormalizedOutline | undefined {
  const key = outlineCacheKey(text, source, target)
  const cached = normalizedOutlineCache.get(key)
  if (cached) return cached
  const reverse = normalizedOutlineCache.get(outlineCacheKey(text, target, source))
  const normalized = reverse && reverseNormalizedOutline(reverse)
  if (normalized) normalizedOutlineCache.set(key, normalized)
  return normalized
}

function registerPreparedManifest(manifest: FontMorphPreparedManifest | undefined) {
  if (!manifest || (manifest.version !== 1 && manifest.version !== 2)) return
  for (const [key, outline] of Object.entries(manifest.outlines)) {
    normalizedOutlineCache.set(key, outline)
  }
  if (manifest.version !== 2) return
  for (const [key, morph] of Object.entries(manifest.sdfMorphs)) {
    preparedSdfCache.set(key, {
      sourceRun: morph.sourceRun,
      targetRun: morph.targetRun,
      glyphs: Object.fromEntries(
        Object.entries(morph.glyphs).map(([unicode, glyph]) => {
          const { distanceBase64: sourceDistance, ...source } = glyph.source
          const { distanceBase64: targetDistance, ...target } = glyph.target
          return [
            unicode,
            {
              ...glyph,
              source: { ...source, distance: decodeBase64(sourceDistance) },
              target: { ...target, distance: decodeBase64(targetDistance) },
            },
          ]
        }),
      ),
    })
  }
}

function decodeBase64(value: string) {
  const binary = atob(value)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function reversePreparedSdf(morph: PreparedSdfData): PreparedSdfData {
  return {
    sourceRun: morph.targetRun,
    targetRun: morph.sourceRun,
    glyphs: Object.fromEntries(
      Object.entries(morph.glyphs).map(([unicode, glyph]) => [
        unicode,
        {
          ...glyph,
          source: glyph.target,
          target: glyph.source,
          warpRegions: glyph.warpRegions.map((region) => ({
            ...region,
            source: region.target,
            target: region.source,
          })),
        },
      ]),
    ),
  }
}

function cachedPreparedSdf(text: string, source: OutlineInstance, target: OutlineInstance) {
  const key = outlineCacheKey(text, source, target)
  const cached = preparedSdfCache.get(key)
  if (cached) return cached
  const reverse = preparedSdfCache.get(outlineCacheKey(text, target, source))
  if (!reverse) return undefined
  const prepared = reversePreparedSdf(reverse)
  preparedSdfCache.set(key, prepared)
  return prepared
}

async function resolvePreparedSdf(text: string, source: OutlineInstance, target: OutlineInstance) {
  const cached = cachedPreparedSdf(text, source, target)
  if (cached) return cached
  await loadPreparedManifest(text, source, target)
  return cachedPreparedSdf(text, source, target)
}

async function loadPreparedManifest(
  text: string,
  source: OutlineInstance,
  target: OutlineInstance,
) {
  const loader = configuration.loadPreparedOutlines
  if (!loader) return
  const key = outlineCacheKey(text, source, target)
  let pending = preparedManifestLoads.get(key)
  if (!pending) {
    pending = Promise.resolve(
      loader(text, {
        key,
        reverseKey: outlineCacheKey(text, target, source),
        source,
        target,
      }),
    )
      .then(registerPreparedManifest)
      .catch((error: unknown) => {
        preparedManifestLoads.delete(key)
        throw error
      })
    preparedManifestLoads.set(key, pending)
  }
  await pending
}

interface FontMorphWorkerResponse {
  id: number
  outline?: NormalizedOutline
  error?: string
}

function rejectWorkerRequests(error: unknown) {
  for (const request of workerRequests.values()) request.reject(error)
  workerRequests.clear()
  compilerWorker?.terminate()
  compilerWorker = null
}

function getCompilerWorker() {
  if (compilerWorker) return compilerWorker
  const worker = configuration.createWorker?.()
  if (!worker) return undefined
  worker.addEventListener('message', (event: MessageEvent<FontMorphWorkerResponse>) => {
    const pending = workerRequests.get(event.data.id)
    if (!pending) return
    workerRequests.delete(event.data.id)
    if (event.data.outline) pending.resolve(event.data.outline)
    else pending.reject(new Error(event.data.error ?? 'Font morph worker returned no outline'))
  })
  worker.addEventListener('error', (event) => {
    rejectWorkerRequests(event.error ?? new Error(event.message))
  })
  compilerWorker = worker
  return worker
}

function compileOutlineInWorker(text: string, source: OutlineInstance, target: OutlineInstance) {
  const worker = getCompilerWorker()
  if (!worker) return undefined
  const id = ++nextWorkerRequestId
  const result = new Promise<NormalizedOutline>((resolve, reject) => {
    workerRequests.set(id, { resolve, reject })
  })
  worker.postMessage({
    id,
    text,
    source,
    target,
    fontFiles: configuration.fontFiles,
  })
  return result
}

async function resolveNormalizedOutline(
  text: string,
  source: OutlineInstance,
  target: OutlineInstance,
) {
  const key = outlineCacheKey(text, source, target)
  const cached = cachedNormalizedOutline(text, source, target)
  if (cached) return cached
  const existing = outlinePreparationPromises.get(key)
  if (existing) return existing

  const pending = (async () => {
    await loadPreparedManifest(text, source, target)
    let outline = cachedNormalizedOutline(text, source, target)
    if (outline) return outline

    const workerResult = compileOutlineInWorker(text, source, target)
    if (workerResult) {
      outline = await workerResult
      normalizedOutlineCache.set(key, outline)
      return outline
    }

    // Morphing is progressive enhancement. A host that does not provide either
    // prepared data or a worker gets an immediate settled-text handoff rather
    // than unexpected font parsing on the UI thread.
    return { contours: null, fallback: 'not-prepared' } satisfies NormalizedOutline
  })().finally(() => outlinePreparationPromises.delete(key))
  outlinePreparationPromises.set(key, pending)
  return pending
}

function materializePolygon(
  polygon: Polygon,
  endpoint: GlyphEndpoint,
  font: FontMetrics,
  glyphIndex: number,
): Polygon {
  const size = fontSize(endpoint)
  const scale = size / MORPH_VIEWBOX_SIZE
  const canonicalBaseline = (font.ascender / font.unitsPerEm) * MORPH_VIEWBOX_SIZE
  const letterSpacing = glyphIndex * endpoint.style.letterSpacingEm * size
  const width = Math.max(Number.EPSILON, endpoint.logicalRect.width)
  const height = Math.max(Number.EPSILON, endpoint.logicalRect.height)

  return polygon.map(([x, y]) => [
    commandNumber(((x * scale + letterSpacing) / width) * MORPH_VIEWBOX_SIZE),
    commandNumber(
      ((baseline(endpoint, font) + (y - canonicalBaseline) * scale) / height) * MORPH_VIEWBOX_SIZE,
    ),
  ])
}

function materializeOutline(
  source: GlyphEndpoint,
  target: GlyphEndpoint,
  normalized: NormalizedOutline,
): PreparedOutline {
  if (!normalized.contours || !normalized.sourceFont || !normalized.targetFont) {
    return { contours: null, fallback: normalized.fallback }
  }

  return {
    contours: normalized.contours.map((contour) => {
      const sourcePoints = materializePolygon(
        contour.source,
        source,
        normalized.sourceFont!,
        contour.glyphIndex,
      )
      const targetPoints = materializePolygon(
        contour.target,
        target,
        normalized.targetFont!,
        contour.glyphIndex,
      )
      return {
        depth: contour.depth,
        sourcePath: polygonPath(sourcePoints),
        targetPath: polygonPath(targetPoints),
        source: sourcePoints,
        target: targetPoints,
      }
    }),
  }
}

/**
 * Load build-generated correspondence for the mounted endpoint. Unknown text
 * is prepared in the configured worker so the click path remains warm without
 * blocking rendering.
 */
export async function prepareFontMorph(key?: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  const endpoint = key ? findEndpointElement(key) : undefined
  const captured = endpoint ? captureEndpoint(endpoint) : null
  if (!captured) return Promise.resolve()
  const targetRole: FontRole = captured.style.fontRole === 'sans' ? 'serif' : 'sans'
  const source = outlineInstance(captured)
  const target = counterpartOutlineInstance(
    targetRole,
    captured.element,
    captured.style.fontFileIndex,
  )
  const prepared = await resolvePreparedSdf(captured.text, source, target)
  if (!prepared) await resolveNormalizedOutline(captured.text, source, target)
}

function mountPreparedOutline(
  layer: SVGSVGElement,
  source: GlyphEndpoint,
  target: GlyphEndpoint,
  prepared: PreparedOutline,
  overlayRoot?: HTMLElement,
): PreparedMorph {
  if (!prepared.contours) {
    layer.dataset.fontMorphFallback = prepared.fallback ?? 'unavailable'
    return { renderer: 'outline', layer, source, target, contours: null, overlayRoot }
  }

  const maskId = `font-morph-mask-${++nextMaskId}`
  const definitions = createSvgElement(layer.ownerDocument, 'defs')
  const mask = createSvgElement(layer.ownerDocument, 'mask')
  mask.id = maskId
  mask.setAttribute('maskUnits', 'userSpaceOnUse')
  mask.setAttribute('x', '0')
  mask.setAttribute('y', '0')
  mask.setAttribute('width', String(MORPH_VIEWBOX_SIZE))
  mask.setAttribute('height', String(MORPH_VIEWBOX_SIZE))
  mask.style.maskType = 'luminance'

  const contours = prepared.contours.map((contour) => {
    const path = createSvgElement(layer.ownerDocument, 'path')
    path.setAttribute('d', contour.sourcePath)
    path.setAttribute('fill', contour.depth % 2 === 0 ? 'white' : 'black')
    mask.append(path)
    return { ...contour, element: path }
  })

  const fill = createSvgElement(layer.ownerDocument, 'rect')
  fill.setAttribute('width', String(MORPH_VIEWBOX_SIZE))
  fill.setAttribute('height', String(MORPH_VIEWBOX_SIZE))
  fill.setAttribute('fill', 'currentColor')
  fill.setAttribute('mask', `url(#${maskId})`)
  definitions.append(mask)
  layer.replaceChildren(definitions, fill)
  return { renderer: 'outline', layer, source, target, contours, overlayRoot }
}

function prepareOutlineMorph(
  layer: SVGSVGElement,
  source: GlyphEndpoint,
  target: GlyphEndpoint,
  normalized: NormalizedOutline,
  overlayRoot?: HTMLElement,
) {
  return mountPreparedOutline(
    layer,
    source,
    target,
    materializeOutline(source, target, normalized),
    overlayRoot,
  )
}

function createSdfLayer(endpoint: GlyphEndpoint, replay: boolean, overlayRoot?: HTMLElement) {
  const ownerDocument = overlayRoot?.ownerDocument ?? endpoint.element.ownerDocument
  const layer = ownerDocument.createElement('canvas')
  layer.classList.add(replay ? 'font-morph-director-layer' : 'font-morph-layer')
  if (!replay) markTransient(layer)
  layer.dataset.fontMorphRenderer = 'sdf'
  layer.setAttribute('aria-hidden', 'true')
  layer.style.cssText += `${overlayRoot ? 'position:absolute' : 'position:fixed'};inset:0 auto auto 0;z-index:2147483646;display:block;pointer-events:none;transform-origin:top left;mix-blend-mode:plus-lighter;`
  const renderParent = overlayRoot ?? endpoint.element.ownerDocument.body
  renderParent.append(layer)
  return layer
}

function mountPreparedSdf(
  source: GlyphEndpoint,
  target: GlyphEndpoint,
  data: PreparedSdfData,
  replay: boolean,
  overlayRoot?: HTMLElement,
): PreparedSdfMorph {
  return {
    renderer: 'sdf',
    layer: createSdfLayer(source, replay, overlayRoot),
    source,
    target,
    data,
    glyphCanvases: new Map(),
    glyphImages: new Map(),
    frames: new Map(),
    overlayRoot,
  }
}

function sdfGlyphBox(
  endpoint: GlyphEndpoint,
  run: FontMorphCompiledRun,
  glyph: FontMorphCompiledRun['glyphs'][number],
  compiled: FontMorphSdfGlyphPair['source'],
  glyphIndex: number,
  baselineCorrection = 0,
): Rect {
  const size = fontSize(endpoint)
  const scaleX = size / endpoint.frame.logicalWidth
  const scaleY = size / endpoint.frame.logicalHeight
  const authoredSpacing = (endpoint.style.letterSpacingEm * size) / endpoint.frame.logicalWidth
  // CSS letter-spacing contributes one spacing unit per typographic glyph,
  // including trailing spacing in the inline box; a glyph at index n is moved
  // only by the n preceding units.
  const spacingUnits = run.glyphs.length
  const shapedWidth = run.advanceWidth * scaleX + spacingUnits * authoredSpacing
  // FontKit supplies unhinted advances while CSS layout owns the authoritative
  // endpoint width. Preserve the glyphs' true em scale and distribute only the
  // residual advance between them; scaling every glyph to the line box makes
  // the final generated frame visibly narrower or heavier than DOM text.
  const measuredSpacingCorrection =
    spacingUnits > 0 ? (endpoint.rect.width - shapedWidth) / spacingUnits : 0
  const letterSpacing = glyphIndex * (authoredSpacing + measuredSpacingCorrection)
  const lineBaseline = endpoint.rect.top + baseline(endpoint) / endpoint.frame.logicalHeight
  const bounds = compiled.textureBounds
  return {
    left: endpoint.rect.left + (glyph.x + bounds.xMin) * scaleX + letterSpacing,
    top: lineBaseline + baselineCorrection - (glyph.y + bounds.yMax) * scaleY,
    width: (bounds.xMax - bounds.xMin) * scaleX,
    height: (bounds.yMax - bounds.yMin) * scaleY,
  }
}

function restoreEndpointVisibility(element: HTMLElement) {
  const lock = endpointVisibilityLocks.get(element)
  if (!lock) return
  endpointVisibilityLocks.delete(element)
  if (
    element.style.getPropertyValue('opacity') !== '1' ||
    element.style.getPropertyPriority('opacity') !== 'important'
  ) {
    return
  }
  if (lock.opacity) element.style.setProperty('opacity', lock.opacity, lock.priority)
  else element.style.removeProperty('opacity')
}

/**
 * Keep the settled DOM endpoint painted while the compositor-owned handoff is
 * cancelled. Two animation frames guarantee at least one paint with an
 * explicit visible endpoint before its original inline style is restored.
 */
function pinEndpointVisible(element: HTMLElement) {
  restoreEndpointVisibility(element)
  const token = {}
  endpointVisibilityLocks.set(element, {
    opacity: element.style.getPropertyValue('opacity'),
    priority: element.style.getPropertyPriority('opacity'),
    token,
  })
  element.style.setProperty('opacity', '1', 'important')
  const ownerWindow = element.ownerDocument.defaultView
  ownerWindow?.requestAnimationFrame(() => {
    ownerWindow.requestAnimationFrame(() => {
      if (endpointVisibilityLocks.get(element)?.token === token) {
        restoreEndpointVisibility(element)
      }
    })
  })
}

function sdfBaselineCorrection(
  endpoint: GlyphEndpoint,
  run: FontMorphCompiledRun,
  glyphs: PreparedSdfData['glyphs'],
  side: 'source' | 'target',
) {
  const scaleY = endpoint.style.fontSizeToHeight * endpoint.rect.height
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const glyph of run.glyphs) {
    const pair = glyphs[glyph.key ?? glyph.unicode] ?? glyphs[glyph.unicode]
    if (!pair) continue
    const bounds = pair[side].textureBounds
    top = Math.min(top, -(glyph.y + bounds.yMax) * scaleY)
    bottom = Math.max(bottom, -(glyph.y + bounds.yMin) * scaleY)
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return 0

  const context = endpoint.element.ownerDocument.createElement('canvas').getContext('2d')
  if (!context) return 0
  const size = fontSize(endpoint)
  context.font = `${endpoint.style.fontStyle} ${endpoint.style.fontWeight} ${size}px ${endpoint.style.fontFamily}`
  context.direction = endpoint.style.direction
  const metrics = context.measureText(endpoint.text)
  if (
    !Number.isFinite(metrics.actualBoundingBoxAscent) ||
    !Number.isFinite(metrics.actualBoundingBoxDescent)
  ) {
    return 0
  }
  const desiredCenter =
    (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) /
    (2 * endpoint.frame.logicalHeight)
  return desiredCenter - (top + bottom) / 2
}

function paintPreparedSdf(
  prepared: PreparedSdfMorph,
  geometryProgress: number,
  outlineProgress: number,
  opacity = 1,
) {
  const { layer, source, target, data, glyphCanvases, glyphImages, frames, overlayRoot } = prepared
  const ownerDocument = layer.ownerDocument
  const frame = renderingFrame(ownerDocument, overlayRoot, source.frame)
  const ratio = Math.min(3, ownerDocument.defaultView?.devicePixelRatio || 1)
  const pixelWidth = Math.max(1, Math.round(frame.screen.width * ratio))
  const pixelHeight = Math.max(1, Math.round(frame.screen.height * ratio))
  if (layer.width !== pixelWidth) layer.width = pixelWidth
  if (layer.height !== pixelHeight) layer.height = pixelHeight
  layer.style.width = `${frame.screen.width}px`
  layer.style.height = `${frame.screen.height}px`
  layer.style.transform = `translate3d(${frame.screen.left}px, ${frame.screen.top}px, 0)`
  const context = layer.getContext('2d')
  if (!context) return
  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  context.clearRect(0, 0, frame.screen.width, frame.screen.height)
  context.imageSmoothingEnabled = true
  context.globalAlpha = opacity
  const colorProgress = smoothColorProgress(outlineProgress)
  const color = {
    red: Math.round(interpolate(source.style.color.red, target.style.color.red, colorProgress)),
    green: Math.round(
      interpolate(source.style.color.green, target.style.color.green, colorProgress),
    ),
    blue: Math.round(interpolate(source.style.color.blue, target.style.color.blue, colorProgress)),
  }
  const renderedGlyphs = new Set<string>()
  const sourceBaselineCorrection = sdfBaselineCorrection(
    source,
    data.sourceRun,
    data.glyphs,
    'source',
  )
  const targetBaselineCorrection = sdfBaselineCorrection(
    target,
    data.targetRun,
    data.glyphs,
    'target',
  )

  for (let index = 0; index < data.sourceRun.glyphs.length; index += 1) {
    const sourceGlyph = data.sourceRun.glyphs[index]
    const targetGlyph = data.targetRun.glyphs[index]
    const glyphKey = sourceGlyph.key ?? sourceGlyph.unicode
    const compiled = data.glyphs[glyphKey] ?? data.glyphs[sourceGlyph.unicode]
    if (!compiled || !targetGlyph) continue
    const box = interpolateRect(
      sdfGlyphBox(
        source,
        data.sourceRun,
        sourceGlyph,
        compiled.source,
        index,
        sourceBaselineCorrection,
      ),
      sdfGlyphBox(
        target,
        data.targetRun,
        targetGlyph,
        compiled.target,
        index,
        targetBaselineCorrection,
      ),
      geometryProgress,
    )
    let glyphCanvas = glyphCanvases.get(glyphKey)
    if (!glyphCanvas) {
      glyphCanvas = ownerDocument.createElement('canvas')
      glyphCanvas.width = compiled.size
      glyphCanvas.height = compiled.size
      glyphCanvases.set(glyphKey, glyphCanvas)
    }
    if (!renderedGlyphs.has(glyphKey)) {
      let sdfFrame = frames.get(glyphKey)
      if (!sdfFrame) {
        sdfFrame = new Uint8ClampedArray(compiled.size * compiled.size)
        frames.set(glyphKey, sdfFrame)
      }
      renderFontMorphSdfAlphaFrame(compiled, outlineProgress, sdfFrame, {
        coverageRamp: fontMorphSdfCoverageRamp(
          compiled,
          box.width * frame.screen.width,
          box.height * frame.screen.height,
          ratio,
        ),
      })
      const glyphContext = glyphCanvas.getContext('2d')
      if (!glyphContext) continue
      let image = glyphImages.get(glyphKey)
      if (!image) {
        image = glyphContext.createImageData(compiled.size, compiled.size)
        glyphImages.set(glyphKey, image)
      }
      for (let pixel = 0; pixel < sdfFrame.length; pixel += 1) {
        image.data[pixel * 4] = color.red
        image.data[pixel * 4 + 1] = color.green
        image.data[pixel * 4 + 2] = color.blue
        image.data[pixel * 4 + 3] = sdfFrame[pixel]
      }
      glyphContext.putImageData(image, 0, 0)
      renderedGlyphs.add(glyphKey)
    }
    context.drawImage(
      glyphCanvas,
      box.left * frame.screen.width,
      box.top * frame.screen.height,
      box.width * frame.screen.width,
      box.height * frame.screen.height,
    )
  }
  context.globalAlpha = 1
}

function polygonPath(points: Polygon) {
  return `M${points.map((point) => `${point[0]},${point[1]}`).join('L')}Z`
}

// KUTE's per-frame coordinate interpolation is deliberately reproduced here.
// KUTE itself is only needed by the build/worker compiler for path topology.
function interpolateCoordinates(
  source: Polygon,
  target: Polygon,
  length: number,
  progress: number,
): Polygon {
  return Array.from({ length }, (_, index) => [
    Math.trunc((source[index][0] + (target[index][0] - source[index][0]) * progress) * 1_000) /
      1_000,
    Math.trunc((source[index][1] + (target[index][1] - source[index][1]) * progress) * 1_000) /
      1_000,
  ])
}

const coordinateInterpolator = { interpolateCoordinates }

function paintPreparedMorph(
  prepared: PreparedMorph,
  geometryProgress: number,
  outlineProgress: number,
  sourceOpacity = 1,
  runtime?: Pick<KuteMorphRuntime, 'interpolateCoordinates'>,
) {
  const { layer, source, target, contours } = prepared
  layer.style.opacity = String(sourceOpacity)
  setLayerBox(
    layer,
    interpolateRect(source.rect, target.rect, geometryProgress),
    layer.ownerDocument,
    prepared.overlayRoot,
  )
  const colorProgress = smoothColorProgress(outlineProgress)
  setLayerColor(layer, {
    red: interpolate(source.style.color.red, target.style.color.red, colorProgress),
    green: interpolate(source.style.color.green, target.style.color.green, colorProgress),
    blue: interpolate(source.style.color.blue, target.style.color.blue, colorProgress),
  })

  if (!contours || !runtime) return
  for (const contour of contours) {
    if (outlineProgress === 0) {
      contour.element.setAttribute('d', contour.sourcePath)
    } else if (outlineProgress === 1) {
      contour.element.setAttribute('d', contour.targetPath)
    } else {
      contour.element.setAttribute(
        'd',
        polygonPath(
          runtime.interpolateCoordinates(
            contour.source,
            contour.target,
            contour.target.length,
            outlineProgress,
          ),
        ),
      )
    }
  }
}

/**
 * Shared rendering boundary for live navigation, externally controlled
 * progress, and replay. The adapters own clocks and DOM discovery; this
 * session alone owns renderer selection, endpoint retargeting, painting, and
 * teardown.
 */
function mountFontMorphSession(prepared: RenderedMorph): FontMorphRenderSession {
  return {
    get element() {
      return prepared.layer
    },
    get renderer() {
      return prepared.renderer
    },
    get available() {
      return prepared.renderer === 'sdf' || Boolean(prepared.contours)
    },
    get source() {
      return prepared.source
    },
    get target() {
      return prepared.target
    },
    setEndpoints(source, target, refreshGeometry = false) {
      prepared.source = source
      prepared.target = target
      if (refreshGeometry && prepared.renderer === 'outline' && prepared.contours) {
        const normalized = cachedNormalizedOutline(
          source.text,
          outlineInstance(source),
          outlineInstance(target),
        )
        if (normalized) {
          const materialized = materializeOutline(source, target, normalized)
          if (materialized.contours?.length === prepared.contours.length) {
            for (let index = 0; index < prepared.contours.length; index += 1) {
              Object.assign(prepared.contours[index], materialized.contours[index])
            }
          }
        }
      }
    },
    render(geometryProgress, outlineProgress = geometryProgress, opacity = 1) {
      const clampedGeometry = Math.min(1, Math.max(0, geometryProgress))
      const clampedOutline = Math.min(1, Math.max(0, outlineProgress))
      if (prepared.renderer === 'sdf') {
        prepared.layer.style.opacity = String(opacity)
        paintPreparedSdf(prepared, clampedGeometry, clampedOutline)
      } else {
        paintPreparedMorph(
          prepared,
          clampedGeometry,
          clampedOutline,
          opacity,
          coordinateInterpolator,
        )
      }
    },
    destroy() {
      prepared.layer.remove()
    },
  }
}

async function createResolvedFontMorphSession(
  source: GlyphEndpoint,
  target: GlyphEndpoint,
  replay: boolean,
  overlayRoot?: HTMLElement,
) {
  const sourceInstance = outlineInstance(source)
  const targetInstance = outlineInstance(target)
  const sdf = await resolvePreparedSdf(source.text, sourceInstance, targetInstance)
  if (sdf) {
    return mountFontMorphSession(mountPreparedSdf(source, target, sdf, replay, overlayRoot))
  }

  const normalized = await resolveNormalizedOutline(source.text, sourceInstance, targetInstance)
  const layer = createInitialLayer(source, replay, overlayRoot)
  return mountFontMorphSession(
    prepareOutlineMorph(layer, source, target, normalized, overlayRoot),
  )
}

function createCachedFontMorphSession(
  source: GlyphEndpoint,
  target: GlyphEndpoint,
  replay: boolean,
  overlayRoot?: HTMLElement,
  preparedOutline?: PreparedOutline,
) {
  const sourceInstance = outlineInstance(source)
  const targetInstance = outlineInstance(target)
  const sdf = cachedPreparedSdf(source.text, sourceInstance, targetInstance)
  if (sdf) {
    return mountFontMorphSession(mountPreparedSdf(source, target, sdf, replay, overlayRoot))
  }

  const normalized = cachedNormalizedOutline(source.text, sourceInstance, targetInstance)
  const outline =
    preparedOutline ??
    (normalized
      ? materializeOutline(source, target, normalized)
      : { contours: null, fallback: 'not-prepared' })
  const layer = createInitialLayer(source, replay, overlayRoot)
  return mountFontMorphSession(mountPreparedOutline(layer, source, target, outline, overlayRoot))
}

export interface FontMorphProgressOptions {
  /** The live text element whose box and font define progress 0. */
  source: HTMLElement
  /** The live text element whose box and font define progress 1. */
  target: HTMLElement
  /** Initial normalized progress. Values outside 0..1 are clamped. */
  initialProgress?: number
}

export interface FontMorphProgressController {
  /** The canvas or SVG layer rendered above the two reference endpoints. */
  readonly element: HTMLCanvasElement | SVGSVGElement
  /** Renderer selected from the same prepared data used by route and replay morphs. */
  readonly renderer: 'sdf' | 'outline'
  /** The controller's most recently rendered normalized progress. */
  readonly progress: number
  /** Render one deterministic frame. Values outside 0..1 are clamped. */
  setProgress(progress: number): void
  /** Remeasure both endpoints after an application-driven layout change. */
  refresh(): void
  /** Remove the rendering layer and release resize observers. */
  destroy(): void
}

/**
 * Creates a manually controlled font morph between two simultaneously mounted
 * copies of the same text. Unlike {@link beginFontMorph}, this routine owns no
 * clock: callers supply normalized progress, which makes it useful for range
 * inputs, scroll-linked effects, animation tooling, and deterministic tests.
 */
export async function createFontMorphProgressController({
  source: sourceElement,
  target: targetElement,
  initialProgress = 0,
}: FontMorphProgressOptions): Promise<FontMorphProgressController> {
  if (sourceElement.ownerDocument !== targetElement.ownerDocument) {
    throw new Error('Glyphflux: controlled endpoints must share a document')
  }

  const ownerDocument = sourceElement.ownerDocument
  await ownerDocument.fonts?.ready

  const capturePair = () => {
    const source = captureEndpoint(sourceElement)
    const target = captureEndpoint(targetElement)
    if (!source || !target) {
      throw new Error('Glyphflux: controlled endpoints must be visible, non-empty text')
    }
    if (source.text !== target.text) {
      throw new Error('Glyphflux: controlled endpoints must contain the same text')
    }
    return { source, target }
  }

  const initial = capturePair()
  const blendRoot = createBlendRoot(initial.source)
  const session = await createResolvedFontMorphSession(
    initial.source,
    initial.target,
    false,
    blendRoot,
  )
  if (!session.available) {
    session.destroy()
    blendRoot.remove()
    throw new Error(
      `Glyphflux: no prepared morph is available for controlled text "${initial.source.text}"`,
    )
  }

  const clampProgress = (progress: number) =>
    Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
  let destroyed = false
  let currentProgress = clampProgress(initialProgress)
  let endpoints = capturePair()
  const layer = session.element
  layer.classList.add('font-morph-progress-layer')
  layer.dataset.fontMorphProgress = ''
  layer.dataset.fontMorphSourceRole = endpoints.source.style.fontRole
  layer.dataset.fontMorphTargetRole = endpoints.target.style.fontRole

  const paint = () => {
    refreshBlendRoot(blendRoot, ownerDocument)
    session.render(currentProgress)
  }
  const refresh = () => {
    if (destroyed || !sourceElement.isConnected || !targetElement.isConnected) return
    endpoints = capturePair()
    layer.dataset.fontMorphSourceRole = endpoints.source.style.fontRole
    layer.dataset.fontMorphTargetRole = endpoints.target.style.fontRole
    session.setEndpoints(endpoints.source, endpoints.target, true)
    paint()
  }
  const setProgress = (progress: number) => {
    if (destroyed) return
    currentProgress = clampProgress(progress)
    paint()
  }

  const ownerWindow = ownerDocument.defaultView
  const resizeObserver = ownerWindow?.ResizeObserver
    ? new ownerWindow.ResizeObserver(refresh)
    : null
  resizeObserver?.observe(sourceElement)
  resizeObserver?.observe(targetElement)
  ownerWindow?.addEventListener('resize', refresh)
  paint()

  return {
    element: layer,
    renderer: session.renderer,
    get progress() {
      return currentProgress
    },
    setProgress,
    refresh,
    destroy() {
      if (destroyed) return
      destroyed = true
      resizeObserver?.disconnect()
      ownerWindow?.removeEventListener('resize', refresh)
      session.destroy()
      blendRoot.remove()
    },
  }
}

function emitRecordedMorph(
  key: string,
  leadIn: number,
  duration: number,
  source: GlyphEndpoint,
  target: GlyphEndpoint,
) {
  source.element.ownerDocument.defaultView?.dispatchEvent(
    new CustomEvent<RecordedFontMorph>(FONT_MORPH_RECORD_EVENT, {
      detail: {
        version: 2,
        key,
        leadIn,
        duration,
        settledTextHold: SETTLED_TEXT_HOLD_MS,
        source: recordedEndpoint(source),
        target: recordedEndpoint(target),
      },
    }),
  )
}

function cleanup(morph: ActiveMorph) {
  if (activeMorph !== morph) return
  morph.observer.disconnect()
  window.clearTimeout(morph.timeout)
  if (morph.frame !== null) cancelAnimationFrame(morph.frame)
  // Pin the destination before removing the isolated handoff layers so the
  // settled DOM and the final exact clone overlap for at least one paint.
  if (morph.handoffElement?.isConnected) pinEndpointVisible(morph.handoffElement)
  document.documentElement.removeAttribute('data-font-morph-active')
  morph.sourceHandoffLayer?.remove()
  morph.targetHandoffLayer?.remove()
  morph.layer.remove()
  morph.blendRoot.remove()
  activeMorph = null
}

function waitForLayout() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}

async function animateTo(morph: ActiveMorph, targetElement: HTMLElement) {
  if (morph.finishing || activeMorph !== morph) return
  morph.finishing = true

  await waitForLayout()
  if (activeMorph !== morph || !targetElement.isConnected) {
    cleanup(morph)
    return
  }

  const provisionalTarget = captureEndpoint(targetElement)
  if (!provisionalTarget) {
    cleanup(morph)
    return
  }

  if ('fonts' in document) {
    try {
      const size = fontSize(provisionalTarget)
      const font = `${provisionalTarget.style.fontStyle} ${provisionalTarget.style.fontWeight} ${size}px ${provisionalTarget.style.fontFamily}`
      // CSS faces are requested during initial page load. Avoid paying another
      // pair of layout frames when the exact destination face is already
      // ready; only a genuine cache miss needs the asynchronous font gate.
      if (!document.fonts.check(font, provisionalTarget.text)) {
        await document.fonts.load(font, provisionalTarget.text)
        await waitForLayout()
      }
    } catch {
      // The outline renderer uses the self-hosted face even if a platform
      // fallback rejects an explicit FontFaceSet load.
    }
  }
  if (activeMorph !== morph || !targetElement.isConnected) {
    cleanup(morph)
    return
  }

  const target = captureEndpoint(targetElement)
  if (!target || !isInCaptureFrame(target.rect)) {
    cleanup(morph)
    return
  }

  let session: FontMorphRenderSession
  try {
    session = await createResolvedFontMorphSession(
      morph.source,
      target,
      false,
      morph.blendRoot,
    )
    if (activeMorph !== morph) return
    const sourceHandoffLayer = morph.layer
    sourceHandoffLayer.classList.remove('font-morph-layer')
    sourceHandoffLayer.classList.add('font-morph-source-layer')
    morph.sourceHandoffLayer = sourceHandoffLayer
    morph.layer = session.element
  } catch (error) {
    console.error('Unable to prepare font morph geometry', error)
    cleanup(morph)
    return
  }
  if (activeMorph !== morph) return
  // Do not imitate a font morph by merely moving live sans-serif text. If a
  // glyph's topology cannot be paired safely, reveal the destination now.
  if (!session.available) {
    cleanup(morph)
    return
  }

  const duration = Math.max(1, readDuration())
  const startedAt = performance.now()
  const targetHandoffLayer = createInitialDomLayer(target, false, morph.blendRoot)
  targetHandoffLayer.classList.remove('font-morph-layer')
  targetHandoffLayer.classList.add('font-morph-target-layer')
  morph.targetHandoffLayer = targetHandoffLayer
  // Mounting the prepared and destination layers happens between paints. Give
  // them the exact t=0 handoff weights immediately so the browser can never
  // composite three fully opaque copies before the first animation callback.
  const initialHandoff = endpointHandoffOpacities(0, duration)
  if (morph.sourceHandoffLayer) {
    morph.sourceHandoffLayer.style.opacity = String(initialHandoff.source)
  }
  morph.layer.style.opacity = String(initialHandoff.renderer)
  targetHandoffLayer.style.opacity = String(initialHandoff.destination)
  startEndpointHandoff(morph, target.element)
  emitRecordedMorph(
    morph.key,
    Math.max(0, performance.now() - morph.startedAt),
    duration,
    morph.source,
    target,
  )
  const paint = (time: number) => {
    if (activeMorph !== morph) return
    refreshBlendRoot(morph.blendRoot, morph.layer.ownerDocument)
    const linearProgress = Math.min(1, (time - startedAt) / duration)
    const geometryProgress = transitionEase(linearProgress)
    const currentTarget = findMatchingEndpoint(
      morph.layer.ownerDocument,
      morph.key,
      target,
      target.text,
      morph.source.element,
    )
    // Navigation, active-navbar styling, resizing, orientation changes, and
    // scrolling can all reflow the destination while the morph is moving.
    // Follow the semantic endpoint itself instead of freezing its first pixel
    // box. If that endpoint leaves the capture frame (or is replaced by a
    // different locale/message), settle on the real post-navigation DOM.
    if (currentTarget) {
      session.setEndpoints(morph.source, currentTarget)
      startEndpointHandoff(morph, currentTarget.element)
    }
    const currentRect = interpolateRect(morph.source.rect, session.target.rect, geometryProgress)
    if (!currentTarget && !isInCaptureFrame(currentRect)) {
      cleanup(morph)
      return
    }
    if (currentTarget && !isInCaptureFrame(currentTarget.rect) && !isInCaptureFrame(currentRect)) {
      cleanup(morph)
      return
    }
    // Position/size retain the shared-element ease, but shape and color
    // interpolation stay linear so the serifs develop throughout the full
    // transition instead of being compressed into one part of it.
    if (morph.sourceHandoffLayer) {
      setDomHandoffLayerBox(
        morph.sourceHandoffLayer,
        morph.source.rect,
        currentRect,
        morph.layer.ownerDocument,
        morph.blendRoot,
      )
    }
    if (morph.targetHandoffLayer) {
      setDomHandoffLayerBox(
        morph.targetHandoffLayer,
        session.target.rect,
        currentRect,
        morph.layer.ownerDocument,
        morph.blendRoot,
      )
    }
    const handoff = endpointHandoffOpacities(linearProgress, duration)
    if (morph.sourceHandoffLayer) {
      morph.sourceHandoffLayer.style.opacity = String(handoff.source)
    }
    if (morph.targetHandoffLayer) {
      morph.targetHandoffLayer.style.opacity = String(handoff.destination)
    }
    session.render(geometryProgress, linearProgress, handoff.renderer)

    if (linearProgress < 1) {
      morph.frame = requestAnimationFrame(paint)
    } else {
      // Preserve one fully settled painted frame before replacing the exact
      // destination clone with the authored DOM endpoint.
      morph.frame = requestAnimationFrame(() => cleanup(morph))
    }
  }

  morph.frame = requestAnimationFrame(paint)
}

function measureAdvance(recorded: RecordedGlyphEndpoint, text: string, ownerDocument: Document) {
  const canvas = ownerDocument.createElement('canvas')
  const context = canvas.getContext('2d')
  if (!context) return recorded.rect.width
  const size = 100
  context.font = `${recorded.style.fontStyle} ${recorded.style.fontWeight} ${size}px ${recorded.style.fontFamily}`
  context.direction = recorded.style.direction
  const spacing = recorded.style.letterSpacingEm * size
  return context.measureText(text).width + Math.max(0, [...text].length - 1) * spacing
}

function translatedEndpoint(
  recorded: RecordedGlyphEndpoint,
  translatedText: string,
  ownerDocument: Document,
  targetElement: HTMLElement,
  frameOverride?: CaptureFrame,
) {
  const recordedAdvance = measureAdvance(recorded, recorded.text, ownerDocument)
  const translatedAdvance = measureAdvance(recorded, translatedText, ownerDocument)
  const ratio = recordedAdvance > 0 ? translatedAdvance / recordedAdvance : 1
  return endpointFromRecorded(
    recorded,
    translatedText,
    ownerDocument,
    targetElement,
    ratio,
    frameOverride,
  )
}

async function loadRecordedEndpointFont(
  recorded: RecordedGlyphEndpoint,
  text: string,
  ownerDocument: Document,
  frame: CaptureFrame,
) {
  if (!ownerDocument.fonts) return
  const logical = logicalRect(recorded.rect, frame)
  const size = recorded.style.fontSizeToHeight * logical.height
  const font = `${recorded.style.fontStyle} ${recorded.style.fontWeight} ${size}px ${recorded.style.fontFamily}`
  try {
    await ownerDocument.fonts.load(font, text)
  } catch {
    // A live endpoint can still supply its exact baseline if a platform font
    // rejects an explicit FontFaceSet request.
  }
}

export interface FontMorphFramePreparation {
  payload: FontMorphRecording
  text: string
  captureFrame: FontMorphCaptureFrame
}

/** Prepares build-generated SDF data or the KUTE fallback for deterministic frames. */
export async function prepareFontMorphFrames(
  preparations: readonly FontMorphFramePreparation[],
  ownerDocument: Document,
) {
  const preparedByDirection = new Map<string, PreparedOutline>()
  const endpointKey = (endpoint: GlyphEndpoint) =>
    JSON.stringify({ text: endpoint.text, rect: endpoint.rect, style: endpoint.style })
  const reverseOutline = (prepared: PreparedOutline): PreparedOutline => ({
    fallback: prepared.fallback,
    contours:
      prepared.contours?.map((contour) => ({
        ...contour,
        sourcePath: contour.targetPath,
        targetPath: contour.sourcePath,
        source: contour.target,
        target: contour.source,
      })) ?? null,
  })

  for (const { payload, text, captureFrame: frame } of preparations) {
    const endpointElement =
      findEndpointElement(payload.key, undefined, ownerDocument) ?? ownerDocument.documentElement
    let textCache = recordingOutlineCache.get(payload)
    if (!textCache) {
      textCache = new Map()
      recordingOutlineCache.set(payload, textCache)
    }
    if (textCache.has(text)) continue
    const translatedText = text
    await Promise.all([
      loadRecordedEndpointFont(payload.source, translatedText, ownerDocument, frame),
      loadRecordedEndpointFont(payload.target, translatedText, ownerDocument, frame),
    ])
    const source = translatedEndpoint(
      payload.source,
      translatedText,
      ownerDocument,
      endpointElement,
      frame,
    )
    const target = translatedEndpoint(
      payload.target,
      translatedText,
      ownerDocument,
      endpointElement,
      frame,
    )
    const sdf = await resolvePreparedSdf(
      translatedText,
      outlineInstance(source),
      outlineInstance(target),
    )
    if (sdf) {
      textCache.set(text, { contours: null, fallback: 'sdf' })
      continue
    }
    const sourceKey = endpointKey(source)
    const targetKey = endpointKey(target)
    const directionKey = `${sourceKey}>${targetKey}`
    const reverseDirectionKey = `${targetKey}>${sourceKey}`
    let prepared = preparedByDirection.get(directionKey)
    if (!prepared) {
      const reverse = preparedByDirection.get(reverseDirectionKey)
      prepared = reverse
        ? reverseOutline(reverse)
        : materializeOutline(
            source,
            target,
            await resolveNormalizedOutline(
              translatedText,
              outlineInstance(source),
              outlineInstance(target),
            ),
          )
      preparedByDirection.set(directionKey, prepared)
    }
    textCache.set(text, prepared)
  }
}

export interface FontMorphFrame {
  document: Document | null
  payload: FontMorphRecording | null
  text: string
  /** Absolute normalized progress. The renderer owns no clock or tween state. */
  progress: number
  phase: 'active' | 'settled' | 'idle'
  /** Optional host layer aligned to the visible capture frame. */
  overlayRoot?: HTMLElement | null
}

export interface FontMorphFrameResult {
  /** The interpolated and destination boxes are both outside the capture frame. */
  completedEarly?: boolean
  /** Whether the settled destination is at least partially visible. */
  destinationVisible?: boolean
}

/**
 * Replay-neutral deterministic frame renderer. Build-generated SDF data is
 * preferred and prepared SVG contours remain the compatibility fallback.
 * Callers own event parsing, clocks, locale changes, seeking, and holds.
 */
export function createFontMorphFrameRenderer() {
  let state: FrameMorphState | null = null

  const clear = () => {
    restoreFrameHandoffs(state)
    state?.document.documentElement.removeAttribute('data-font-morph-fallback')
    state?.sourceHandoffLayer?.remove()
    state?.targetHandoffLayer?.remove()
    state?.session.destroy()
    state?.blendRoot.remove()
    state = null
  }

  return (frame: FontMorphFrame): FontMorphFrameResult | undefined => {
    if (!frame.document) {
      clear()
      return
    }

    const payload = frame.payload
    if (!payload || frame.phase === 'idle') {
      clear()
      // A recorder can retain the hiding attribute for a few milliseconds
      // between adjacent semantic events. Never expose it as a blank gap.
      if (frame.document.documentElement.hasAttribute('data-font-morph-active')) {
        frame.document.documentElement.dataset.fontMorphFallback = ''
      }
      return
    }

    // A backward seek must rebuild transient state. Whether a destination has
    // appeared may never leak backward into an earlier frame.
    if (state && frame.progress < state.lastProgress) clear()

    if (frame.phase === 'settled') {
      clear()
      const currentTarget = findMatchingEndpoint(
        frame.document,
        payload.key,
        payload.target,
        frame.text,
      )
      frame.document.documentElement.dataset.fontMorphFallback = ''
      return { destinationVisible: Boolean(currentTarget && isInCaptureFrame(currentTarget.rect)) }
    }

    if (
      !state ||
      state.payload !== payload ||
      state.document !== frame.document ||
      state.text !== frame.text ||
      state.hostRoot !== (frame.overlayRoot ?? undefined) ||
      !state.session.element.isConnected
    ) {
      clear()
      const translatedText = frame.text
      const endpointElement =
        findEndpointElement(payload.key, undefined, frame.document) ??
        frame.document.documentElement
      // Endpoint geometry comes from the semantic event, not whichever route
      // happens to be mounted on this frame. This lets the director render the
      // stationary source immediately, before the destination DOM is committed.
      const source = translatedEndpoint(
        payload.source,
        translatedText,
        frame.document,
        endpointElement,
      )
      const target = translatedEndpoint(
        payload.target,
        translatedText,
        frame.document,
        endpointElement,
      )
      const blendRoot = createBlendRoot(source, true, frame.overlayRoot ?? undefined)
      const cachedOutline = recordingOutlineCache.get(payload)?.get(translatedText)
      const session = createCachedFontMorphSession(
        source,
        target,
        true,
        blendRoot,
        cachedOutline,
      )
      state = {
        payload,
        document: frame.document,
        text: translatedText,
        session,
        sawTarget: false,
        lastProgress: frame.progress,
        handoffSource: null,
        handoffTarget: null,
        sourceHandoffElement: null,
        sourceHandoffLayer: null,
        targetHandoffElement: null,
        targetHandoffLayer: null,
        blendRoot,
        hostRoot: frame.overlayRoot ?? undefined,
      }
      if (!session.available) {
        session.element.replaceChildren()
        session.element.style.display = 'none'
        session.element.ownerDocument.documentElement.dataset.fontMorphFallback = ''
      }
    }

    state.lastProgress = frame.progress
    refreshBlendRoot(state.blendRoot, frame.document, state.hostRoot)
    const translatedText = frame.text
    const currentSource = findMatchingEndpoint(
      frame.document,
      payload.key,
      payload.source,
      translatedText,
    )
    const currentTarget = findMatchingEndpoint(
      frame.document,
      payload.key,
      payload.target,
      translatedText,
    )
    if (currentTarget) {
      state.sawTarget = true
      state.session.setEndpoints(state.session.source, currentTarget)
    }
    if (!state.session.available) {
      restoreFrameHandoffs(state)
      state.sourceHandoffLayer?.remove()
      state.targetHandoffLayer?.remove()
      state.sourceHandoffElement = null
      state.sourceHandoffLayer = null
      state.targetHandoffElement = null
      state.targetHandoffLayer = null
      state.session.element.style.display = 'none'
      frame.document.documentElement.dataset.fontMorphFallback = ''
      return
    }
    const sourceHandoffLayer = syncFrameDomHandoff(state, 'source', currentSource)
    const targetHandoffLayer = syncFrameDomHandoff(state, 'target', currentTarget)
    const linearProgress = Math.min(1, Math.max(0, frame.progress))
    const geometryProgress = transitionEase(linearProgress)
    const currentRect = interpolateRect(
      state.session.source.rect,
      state.session.target.rect,
      geometryProgress,
    )
    if (
      (!currentTarget && state.sawTarget && !isInCaptureFrame(currentRect)) ||
      (currentTarget && !isInCaptureFrame(currentTarget.rect) && !isInCaptureFrame(currentRect))
    ) {
      restoreFrameHandoffs(state)
      state.session.element.style.display = 'none'
      if (sourceHandoffLayer) sourceHandoffLayer.style.display = 'none'
      if (targetHandoffLayer) targetHandoffLayer.style.display = 'none'
      frame.document.documentElement.dataset.fontMorphFallback = ''
      return { completedEarly: true }
    }
    state.session.element.style.display = 'block'
    if (sourceHandoffLayer) sourceHandoffLayer.style.display = 'block'
    if (targetHandoffLayer) targetHandoffLayer.style.display = 'block'
    frame.document.documentElement.removeAttribute('data-font-morph-fallback')

    const handoff = endpointHandoffOpacities(
      linearProgress,
      payload.duration,
      Boolean(currentSource),
      Boolean(currentTarget),
    )
    setFrameHandoff(state, 'source', currentSource?.element ?? null, 0)
    setFrameHandoff(state, 'target', currentTarget?.element ?? null, 0)
    if (sourceHandoffLayer) {
      sourceHandoffLayer.style.opacity = String(handoff.source)
      setDomHandoffLayerBox(
        sourceHandoffLayer,
        state.session.source.rect,
        currentRect,
        frame.document,
        state.blendRoot,
      )
    }
    if (targetHandoffLayer) {
      targetHandoffLayer.style.opacity = String(handoff.destination)
      setDomHandoffLayerBox(
        targetHandoffLayer,
        state.session.target.rect,
        currentRect,
        frame.document,
        state.blendRoot,
      )
    }
    // Endpoint blending is also a pure function of absolute replay time, so
    // seeking and rewinding cannot retain opacity hysteresis.
    state.session.render(geometryProgress, linearProgress, handoff.renderer)
  }
}

/**
 * Captures the currently mounted endpoint and waits for navigation to mount
 * another element with the same key. The recorded geometry is relative to the
 * configured capture frame; recordings contain no renderer frames or geometry.
 */
export function beginFontMorph(key: string) {
  if (
    typeof document === 'undefined' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    return false
  }

  if (activeMorph) cleanup(activeMorph)
  const sourceElement = findEndpointElement(key)
  if (!sourceElement) return false
  // A destination pinned during the prior handoff can immediately become the
  // source of a reverse transition. Restore its authored style before capture
  // so the new root hiding rule can take effect atomically.
  restoreEndpointVisibility(sourceElement)
  const source = captureEndpoint(sourceElement)
  if (!source || !isInCaptureFrame(source.rect)) return false
  const blendRoot = createBlendRoot(source)
  const layer = createInitialDomLayer(source, false, blendRoot)

  const observer = new MutationObserver(() => {
    const destination = findEndpointElement(key, sourceElement)
    if (destination) void animateTo(morph, destination)
  })
  const morph: ActiveMorph = {
    key,
    source,
    layer,
    startedAt: performance.now(),
    observer,
    timeout: 0,
    frame: null,
    finishing: false,
    handoffElement: null,
    sourceHandoffLayer: null,
    targetHandoffLayer: null,
    blendRoot,
  }
  activeMorph = morph
  document.documentElement.dataset.fontMorphActive = key
  observer.observe(document.body, { childList: true, subtree: true })
  morph.timeout = window.setTimeout(() => cleanup(morph), DESTINATION_TIMEOUT_MS)
  void prepareFontMorph(key).catch(() => undefined)

  // Some routers reuse the surrounding DOM and commit before a mutation
  // observer gets its turn. The next frame catches that case.
  requestAnimationFrame(() => {
    const destination = findEndpointElement(key, sourceElement)
    if (destination) void animateTo(morph, destination)
  })
  return true
}
