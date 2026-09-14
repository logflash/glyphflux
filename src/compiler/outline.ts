import type { Font, Glyph, PathCommand, RenderOptions } from 'opentype.js'
import type { FontMorphBounds, FontMorphCompiledRun, FontMorphPoint } from '../contracts/font'
import { compareNumber, quantizeCoordinate } from './fixedPoint'
import type { FontMorphOutlineFont, FontMorphOutlinePathCommand } from './fontParser'

export interface FontMorphOutlineContour {
  id: string
  points: FontMorphPoint[]
  signedArea: number
  winding: -1 | 1
  depth: number
  kind: 'positive' | 'negative'
}

export interface FontMorphExtractedGlyph {
  glyphId: number
  advanceWidth: number
  bounds: FontMorphBounds
  contours: FontMorphOutlineContour[]
  originalCommands: PathCommand[]
}

interface MutablePoint {
  x: number
  y: number
}

interface RawContour {
  points: FontMorphPoint[]
  signedArea: number
  winding: -1 | 1
  depth: number
  parent: number | null
}

function point(x: number, y: number): MutablePoint {
  return { x: quantizeCoordinate(x), y: quantizeCoordinate(-y) }
}

function distanceToLineSquared(value: MutablePoint, start: MutablePoint, end: MutablePoint) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (dx === 0 && dy === 0) {
    return (value.x - start.x) ** 2 + (value.y - start.y) ** 2
  }
  const cross = dy * value.x - dx * value.y + end.x * start.y - end.y * start.x
  return (cross * cross) / (dx * dx + dy * dy)
}

function midpoint(left: MutablePoint, right: MutablePoint): MutablePoint {
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 }
}

function flattenQuadratic(
  start: MutablePoint,
  control: MutablePoint,
  end: MutablePoint,
  toleranceSquared: number,
  output: MutablePoint[],
  depth = 0,
) {
  if (depth >= 18 || distanceToLineSquared(control, start, end) <= toleranceSquared) {
    output.push(end)
    return
  }
  const leftControl = midpoint(start, control)
  const rightControl = midpoint(control, end)
  const split = midpoint(leftControl, rightControl)
  flattenQuadratic(start, leftControl, split, toleranceSquared, output, depth + 1)
  flattenQuadratic(split, rightControl, end, toleranceSquared, output, depth + 1)
}

function flattenCubic(
  start: MutablePoint,
  control1: MutablePoint,
  control2: MutablePoint,
  end: MutablePoint,
  toleranceSquared: number,
  output: MutablePoint[],
  depth = 0,
) {
  const flatness = Math.max(
    distanceToLineSquared(control1, start, end),
    distanceToLineSquared(control2, start, end),
  )
  if (depth >= 18 || flatness <= toleranceSquared) {
    output.push(end)
    return
  }
  const left1 = midpoint(start, control1)
  const center = midpoint(control1, control2)
  const right2 = midpoint(control2, end)
  const left2 = midpoint(left1, center)
  const right1 = midpoint(center, right2)
  const split = midpoint(left2, right1)
  flattenCubic(start, left1, left2, split, toleranceSquared, output, depth + 1)
  flattenCubic(split, right1, right2, end, toleranceSquared, output, depth + 1)
}

function samePoint(left: MutablePoint, right: MutablePoint) {
  return left.x === right.x && left.y === right.y
}

function closeContour(points: MutablePoint[]) {
  const deduplicated: FontMorphPoint[] = []
  for (const value of points) {
    const next = [quantizeCoordinate(value.x), quantizeCoordinate(value.y)] as const
    const previous = deduplicated.at(-1)
    if (!previous || previous[0] !== next[0] || previous[1] !== next[1]) deduplicated.push(next)
  }
  if (
    deduplicated.length > 1 &&
    deduplicated[0][0] === deduplicated.at(-1)![0] &&
    deduplicated[0][1] === deduplicated.at(-1)![1]
  ) {
    deduplicated.pop()
  }
  return deduplicated
}

export function flattenPath(commands: readonly PathCommand[], tolerance = 1 / 2048) {
  const contours: FontMorphPoint[][] = []
  let output: MutablePoint[] = []
  let current: MutablePoint | null = null
  let start: MutablePoint | null = null
  const toleranceSquared = tolerance * tolerance

  const finish = () => {
    const contour = closeContour(output)
    if (contour.length >= 3) contours.push(contour)
    output = []
    current = null
    start = null
  }

  for (const command of commands) {
    if (command.type === 'M') {
      if (output.length) finish()
      current = point(command.x, command.y)
      start = current
      output.push(current)
    } else if (command.type === 'Z') {
      if (current && start && !samePoint(current, start)) output.push(start)
      finish()
    } else {
      if (!current) throw new Error(`Glyphflux outline command ${command.type} has no move point`)
      const end = point(command.x, command.y)
      if (command.type === 'L') {
        output.push(end)
      } else if (command.type === 'Q') {
        flattenQuadratic(current, point(command.x1, command.y1), end, toleranceSquared, output)
      } else if (command.type === 'C') {
        flattenCubic(
          current,
          point(command.x1, command.y1),
          point(command.x2, command.y2),
          end,
          toleranceSquared,
          output,
        )
      }
      current = end
    }
  }
  if (output.length) finish()
  return contours
}

export function signedPolygonArea(points: readonly FontMorphPoint[]) {
  let doubledArea = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    doubledArea += current[0] * next[1] - next[0] * current[1]
  }
  return quantizeCoordinate(doubledArea / 2)
}

function pointInPolygon(value: FontMorphPoint, polygon: readonly FontMorphPoint[]) {
  let inside = false
  for (
    let current = 0, previous = polygon.length - 1;
    current < polygon.length;
    previous = current++
  ) {
    const [x, y] = polygon[current]
    const [previousX, previousY] = polygon[previous]
    const crosses =
      y > value[1] !== previousY > value[1] &&
      value[0] < ((previousX - x) * (value[1] - y)) / (previousY - y) + x
    if (crosses) inside = !inside
  }
  return inside
}

function comparePoints(left: FontMorphPoint, right: FontMorphPoint) {
  return compareNumber(left[0], right[0]) || compareNumber(left[1], right[1])
}

function canonicalStart(points: FontMorphPoint[]) {
  let start = 0
  for (let index = 1; index < points.length; index += 1) {
    if (comparePoints(points[index], points[start]) < 0) start = index
  }
  return [...points.slice(start), ...points.slice(0, start)]
}

export function classifyOutlineContours(inputs: readonly FontMorphPoint[][]) {
  const contours: RawContour[] = inputs
    .map((input) => {
      const points = canonicalStart([...input])
      const signedArea = signedPolygonArea(points)
      return {
        points,
        signedArea,
        winding: (signedArea < 0 ? -1 : 1) as -1 | 1,
        depth: 0,
        parent: null,
      }
    })
    .filter(({ signedArea }) => signedArea !== 0)
    .sort(
      (left, right) =>
        compareNumber(Math.abs(right.signedArea), Math.abs(left.signedArea)) ||
        comparePoints(left.points[0], right.points[0]),
    )

  for (let index = 0; index < contours.length; index += 1) {
    const contour = contours[index]
    const containers = contours
      .map((candidate, candidateIndex) => ({ candidate, candidateIndex }))
      .filter(
        ({ candidate }) =>
          Math.abs(candidate.signedArea) > Math.abs(contour.signedArea) &&
          candidate.winding !== contour.winding &&
          pointInPolygon(contour.points[0], candidate.points),
      )
      .sort(
        (left, right) =>
          compareNumber(
            Math.abs(left.candidate.signedArea),
            Math.abs(right.candidate.signedArea),
          ) || left.candidateIndex - right.candidateIndex,
      )
    contour.parent = containers[0]?.candidateIndex ?? null
  }

  const depthOf = (index: number, visiting = new Set<number>()): number => {
    if (visiting.has(index)) throw new Error('Glyphflux contour containment contains a cycle')
    const parent = contours[index].parent
    if (parent === null) return 0
    visiting.add(index)
    return depthOf(parent, visiting) + 1
  }
  for (let index = 0; index < contours.length; index += 1) contours[index].depth = depthOf(index)

  return contours.map((contour, index): FontMorphOutlineContour => ({
    id: `contour-${index.toString().padStart(3, '0')}`,
    points: contour.points,
    signedArea: contour.signedArea,
    winding: contour.winding,
    depth: contour.depth,
    kind: contour.depth % 2 === 0 ? 'positive' : 'negative',
  }))
}

function boundsOf(contours: readonly FontMorphOutlineContour[]): FontMorphBounds {
  const points = contours.flatMap(({ points }) => points)
  if (!points.length) return { xMin: 0, yMin: 0, xMax: 0, yMax: 0 }
  return {
    xMin: Math.min(...points.map(([x]) => x)),
    yMin: Math.min(...points.map(([, y]) => y)),
    xMax: Math.max(...points.map(([x]) => x)),
    yMax: Math.max(...points.map(([, y]) => y)),
  }
}

function clampedAxes(font: Font, requested: Record<string, number> | undefined) {
  const axes = (
    font as unknown as {
      tables?: { fvar?: { axes?: { tag: string; minValue: number; maxValue: number }[] } }
    }
  ).tables?.fvar?.axes
  return Object.fromEntries(
    Object.entries(requested ?? {})
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .map(([tag, value]) => {
        const axis = axes?.find((candidate) => candidate.tag === tag)
        return [tag, axis ? Math.min(axis.maxValue, Math.max(axis.minValue, value)) : value]
      }),
  )
}

function glyphPath(glyph: Glyph, font: Font, axes: Record<string, number> | undefined) {
  // opentype.js applies variation coordinates only when the owning Font is
  // passed as the fifth argument. Its published TypeScript declaration still
  // exposes the older four-argument signature, so keep this compatibility
  // cast local to the parser boundary.
  const getPath = glyph.getPath as unknown as (
    x: number,
    y: number,
    fontSize: number,
    options: RenderOptions,
    owner: Font,
  ) => ReturnType<Glyph['getPath']>
  return getPath.call(
    glyph,
    0,
    0,
    1,
    { variation: clampedAxes(font, axes) } as unknown as RenderOptions,
    font,
  )
}

function opentypeCommand(command: FontMorphOutlinePathCommand, scale: number): PathCommand {
  const [x1 = 0, y1 = 0, x2 = 0, y2 = 0, x3 = 0, y3 = 0] = command.args
  switch (command.command) {
    case 'moveTo':
      return { type: 'M', x: x1 * scale, y: -y1 * scale }
    case 'lineTo':
      return { type: 'L', x: x1 * scale, y: -y1 * scale }
    case 'quadraticCurveTo':
      return {
        type: 'Q',
        x1: x1 * scale,
        y1: -y1 * scale,
        x: x2 * scale,
        y: -y2 * scale,
      }
    case 'bezierCurveTo':
      return {
        type: 'C',
        x1: x1 * scale,
        y1: -y1 * scale,
        x2: x2 * scale,
        y2: -y2 * scale,
        x: x3 * scale,
        y: -y3 * scale,
      }
    case 'closePath':
      return { type: 'Z' }
  }
}

/**
 * Extracts an already-instantiated outline from the build-time font engine.
 * This path is used by the distance-field compiler because opentype.js 2.0
 * does not apply all inferred gvar contour deltas correctly.
 */
export function extractFontMorphInstantiatedGlyph(
  font: FontMorphOutlineFont,
  codePoint: number,
  tolerance?: number,
): FontMorphExtractedGlyph {
  return extractInstantiatedOutline(font, font.glyphForCodePoint(codePoint), tolerance)
}

function extractInstantiatedOutline(
  font: FontMorphOutlineFont,
  glyph: ReturnType<FontMorphOutlineFont['getGlyph']>,
  tolerance?: number,
): FontMorphExtractedGlyph {
  const commands = glyph.path.commands.map((command) =>
    opentypeCommand(command, 1 / font.unitsPerEm),
  )
  const contours = classifyOutlineContours(flattenPath(commands, tolerance))
  return {
    glyphId: glyph.id,
    advanceWidth: glyph.advanceWidth / font.unitsPerEm,
    bounds: boundsOf(contours),
    contours,
    originalCommands: commands,
  }
}

/** Extracts the exact glyph selected by contextual shaping. */
export function extractFontMorphInstantiatedGlyphById(
  font: FontMorphOutlineFont,
  glyphId: number,
  tolerance?: number,
) {
  const glyph = font.getGlyph(glyphId)
  if (!glyph) throw new RangeError(`Glyphflux font has no glyph ${glyphId}`)
  return extractInstantiatedOutline(font, glyph, tolerance)
}

/**
 * Combines a shaped visual run into one outline. This is the deterministic
 * fallback when two fonts produce different glyph counts for the same text.
 */
export function extractFontMorphInstantiatedRun(
  font: FontMorphOutlineFont,
  run: FontMorphCompiledRun,
  tolerance?: number,
): FontMorphExtractedGlyph {
  const contours = run.glyphs.flatMap((positioned, glyphIndex) => {
    const outline = extractFontMorphInstantiatedGlyphById(font, positioned.glyphId, tolerance)
    return outline.contours.map((contour) => ({
      ...contour,
      id: `glyph-${glyphIndex.toString().padStart(4, '0')}-${contour.id}`,
      points: contour.points.map(
        ([x, y]) =>
          [quantizeCoordinate(x + positioned.x), quantizeCoordinate(y + positioned.y)] as const,
      ),
    }))
  })
  return {
    glyphId: -1,
    advanceWidth: run.advanceWidth,
    bounds: boundsOf(contours),
    contours,
    originalCommands: [],
  }
}

export function extractFontMorphGlyph(
  font: Font,
  glyphId: number,
  axes?: Record<string, number>,
  tolerance?: number,
): FontMorphExtractedGlyph {
  const glyph = font.glyphs.get(glyphId)
  if (!glyph) throw new RangeError(`Glyphflux font has no glyph ${glyphId}`)
  const path = glyphPath(glyph, font, axes)
  const contours = classifyOutlineContours(flattenPath(path.commands, tolerance))
  return {
    glyphId,
    advanceWidth: (glyph.advanceWidth ?? font.unitsPerEm) / font.unitsPerEm,
    bounds: boundsOf(contours),
    contours,
    originalCommands: path.commands,
  }
}
