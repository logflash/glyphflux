import type {
  FontMorphSdfGlyphPair,
  FontMorphSdfWarpControl,
  FontMorphSdfWarpRegion,
} from '../contracts/sdf'
import { renderFontMorphSdfFrame } from '../sdf-runtime'

const VALIDATION_PROGRESS = [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875] as const
const MAX_WARP_REGIONS = 6
const MAX_ANALYSIS_SIZE = 96

interface TopologySignature {
  components: number
  holes: number
}

interface TopologyRange {
  source: TopologySignature
  target: TopologySignature
}

interface StrokeBand {
  orientation: 'horizontal' | 'vertical'
  axisStart: number
  axisEnd: number
  crossStart: number
  crossEnd: number
  ink: number
}

interface PixelRegion {
  area: number
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface TransientAnomaly extends PixelRegion {
  kind: 'component' | 'hole'
  progress: number
}

function minimumStructuralArea(size: number) {
  // The SDF texture is an intermediate representation, not the output pixel
  // grid. Ignore islands smaller than roughly 1/64 em in each dimension so
  // threshold rounding cannot masquerade as a new stroke or counter.
  return Math.max(2, Math.floor((size * size) / 4096))
}

function floodRegion(
  field: ArrayLike<number>,
  size: number,
  start: number,
  ink: boolean,
  visited: Uint8Array,
) {
  const queue = [start]
  visited[start] = 1
  let area = 0
  let minX = size
  let minY = size
  let maxX = -1
  let maxY = -1
  while (queue.length) {
    const index = queue.pop()!
    area += 1
    const x = index % size
    const y = Math.floor(index / size)
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
    const visit = (neighbor: number) => {
      if (visited[neighbor] || field[neighbor] > 128 !== ink) return
      visited[neighbor] = 1
      queue.push(neighbor)
    }
    if (x > 0) visit(index - 1)
    if (x + 1 < size) visit(index + 1)
    if (index >= size) visit(index - size)
    if (index + size < field.length) visit(index + size)
  }
  return { area, minX, minY, maxX, maxY }
}

function topologySignature(field: ArrayLike<number>, size: number): TopologySignature {
  const minimumArea = minimumStructuralArea(size)
  const visitedInk = new Uint8Array(field.length)
  let components = 0
  for (let start = 0; start < field.length; start += 1) {
    if (visitedInk[start] || field[start] <= 128) continue
    if (floodRegion(field, size, start, true, visitedInk).area >= minimumArea) components += 1
  }

  const visitedBackground = new Uint8Array(field.length)
  const enqueueBackground = (index: number) => {
    if (visitedBackground[index] || field[index] > 128) return
    floodRegion(field, size, index, false, visitedBackground)
  }
  for (let coordinate = 0; coordinate < size; coordinate += 1) {
    enqueueBackground(coordinate)
    enqueueBackground((size - 1) * size + coordinate)
    enqueueBackground(coordinate * size)
    enqueueBackground(coordinate * size + size - 1)
  }
  let holes = 0
  for (let start = 0; start < field.length; start += 1) {
    if (visitedBackground[start] || field[start] > 128) continue
    if (floodRegion(field, size, start, false, visitedBackground).area >= minimumArea) holes += 1
  }
  return { components, holes }
}

function structuralRegions(field: ArrayLike<number>, size: number, ink: boolean) {
  const minimumArea = minimumStructuralArea(size)
  const visited = new Uint8Array(field.length)
  if (!ink) {
    const visitExterior = (index: number) => {
      if (!visited[index] && field[index] <= 128) {
        floodRegion(field, size, index, false, visited)
      }
    }
    for (let coordinate = 0; coordinate < size; coordinate += 1) {
      visitExterior(coordinate)
      visitExterior((size - 1) * size + coordinate)
      visitExterior(coordinate * size)
      visitExterior(coordinate * size + size - 1)
    }
  }
  const regions: PixelRegion[] = []
  for (let start = 0; start < field.length; start += 1) {
    if (visited[start] || field[start] > 128 !== ink) continue
    const region = floodRegion(field, size, start, ink, visited)
    if (region.area >= minimumArea) regions.push(region)
  }
  return regions.sort(
    (left, right) => left.area - right.area || left.minY - right.minY || left.minX - right.minX,
  )
}

function outsideRange(value: number, left: number, right: number) {
  const minimum = Math.min(left, right)
  const maximum = Math.max(left, right)
  return value < minimum ? minimum - value : value > maximum ? value - maximum : 0
}

function topologyPenalty(
  pair: FontMorphSdfGlyphPair,
  regions: FontMorphSdfWarpRegion[],
  range: TopologyRange,
) {
  const candidate = { ...pair, warpRegions: regions }
  let penalty = 0
  for (const progress of VALIDATION_PROGRESS) {
    const signature = topologySignature(renderFontMorphSdfFrame(candidate, progress), pair.size)
    // Strokes that are separate in both fonts can legitimately touch while
    // moving between them. That temporary connection is not destructive as
    // long as it preserves the glyph's counters. Conversely, a component
    // count above both endpoints is an actual transient split and is repaired.
    penalty += Math.max(
      0,
      signature.components - Math.max(range.source.components, range.target.components),
    )
    penalty += outsideRange(signature.holes, range.source.holes, range.target.holes)
  }
  return penalty
}

function resizedDistanceField(field: Uint8Array, sourceSize: number, targetSize: number) {
  const output = new Uint8Array(targetSize * targetSize)
  const coordinateScale = (sourceSize - 1) / (targetSize - 1)
  const distanceScale = targetSize / sourceSize
  for (let y = 0; y < targetSize; y += 1) {
    for (let x = 0; x < targetSize; x += 1) {
      const sourceX = x * coordinateScale
      const sourceY = y * coordinateScale
      const x0 = Math.floor(sourceX)
      const y0 = Math.floor(sourceY)
      const x1 = Math.min(sourceSize - 1, x0 + 1)
      const y1 = Math.min(sourceSize - 1, y0 + 1)
      const fractionX = sourceX - x0
      const fractionY = sourceY - y0
      const top =
        field[y0 * sourceSize + x0] * (1 - fractionX) + field[y0 * sourceSize + x1] * fractionX
      const bottom =
        field[y1 * sourceSize + x0] * (1 - fractionX) + field[y1 * sourceSize + x1] * fractionX
      const sampled = top * (1 - fractionY) + bottom * fractionY
      output[y * targetSize + x] = Math.max(
        0,
        Math.min(255, Math.round(128 + (sampled - 128) * distanceScale)),
      )
    }
  }
  return output
}

function analysisPair(pair: FontMorphSdfGlyphPair): FontMorphSdfGlyphPair {
  return {
    ...pair,
    size: MAX_ANALYSIS_SIZE,
    warpRegions: [],
    source: {
      ...pair.source,
      distance: resizedDistanceField(pair.source.distance, pair.size, MAX_ANALYSIS_SIZE),
    },
    target: {
      ...pair.target,
      distance: resizedDistanceField(pair.target.distance, pair.size, MAX_ANALYSIS_SIZE),
    },
  }
}

function longestInkRun(
  field: Uint8Array,
  size: number,
  axis: number,
  orientation: StrokeBand['orientation'],
) {
  let bestStart = -1
  let bestEnd = -1
  let runStart = -1
  for (let cross = 0; cross <= size; cross += 1) {
    const index =
      cross < size ? (orientation === 'horizontal' ? axis * size + cross : cross * size + axis) : -1
    if (index >= 0 && field[index] > 128) {
      if (runStart < 0) runStart = cross
    } else if (runStart >= 0) {
      if (cross - runStart > bestEnd - bestStart + 1) {
        bestStart = runStart
        bestEnd = cross - 1
      }
      runStart = -1
    }
  }
  return { start: bestStart, end: bestEnd, length: bestEnd - bestStart + 1 }
}

function strokeBands(field: Uint8Array, size: number, orientation: StrokeBand['orientation']) {
  const minimumRun = Math.max(4, Math.floor(size * 0.28))
  const rows = Array.from({ length: size }, (_, axis) => ({
    axis,
    ...longestInkRun(field, size, axis, orientation),
  })).filter(({ length }) => length >= minimumRun)
  const bands: StrokeBand[] = []
  for (const row of rows) {
    const previous = bands.at(-1)
    const overlap = previous
      ? Math.max(
          0,
          Math.min(previous.crossEnd, row.end) - Math.max(previous.crossStart, row.start) + 1,
        )
      : 0
    const shared = previous
      ? overlap / Math.max(1, Math.min(previous.crossEnd - previous.crossStart + 1, row.length))
      : 0
    if (previous && row.axis === previous.axisEnd + 1 && shared >= 0.5) {
      previous.axisEnd = row.axis
      previous.crossStart = Math.min(previous.crossStart, row.start)
      previous.crossEnd = Math.max(previous.crossEnd, row.end)
      previous.ink += row.length
    } else {
      bands.push({
        orientation,
        axisStart: row.axis,
        axisEnd: row.axis,
        crossStart: row.start,
        crossEnd: row.end,
        ink: row.length,
      })
    }
  }
  return bands.filter((band) => {
    const thickness = band.axisEnd - band.axisStart + 1
    return thickness <= size * 0.24 && band.ink >= minimumRun * 2
  })
}

function bandCenter(band: StrokeBand) {
  const axis = (band.axisStart + band.axisEnd) / 2
  const cross = (band.crossStart + band.crossEnd) / 2
  return band.orientation === 'horizontal' ? ([cross, axis] as const) : ([axis, cross] as const)
}

function bandLength(band: StrokeBand) {
  return band.crossEnd - band.crossStart + 1
}

function bandThickness(band: StrokeBand) {
  return band.axisEnd - band.axisStart + 1
}

function candidateRegion(
  source: StrokeBand,
  target: StrokeBand,
  size: number,
  index: number,
): FontMorphSdfWarpRegion {
  const extent = size - 1
  const sourceCenter = bandCenter(source)
  const targetCenter = bandCenter(target)
  const deltaX = Math.abs(targetCenter[0] - sourceCenter[0])
  const deltaY = Math.abs(targetCenter[1] - sourceCenter[1])
  const padding = size * 0.025
  const radius = (band: StrokeBand): readonly [number, number] => {
    const crossRadius = bandLength(band) / 2 + padding
    const axisDelta = band.orientation === 'horizontal' ? deltaY : deltaX
    const axisRadius = Math.max(size * 0.06, bandThickness(band) / 2 + axisDelta * 1.6 + padding)
    return band.orientation === 'horizontal'
      ? [Math.min(extent, crossRadius) / extent, Math.min(extent, axisRadius) / extent]
      : [Math.min(extent, axisRadius) / extent, Math.min(extent, crossRadius) / extent]
  }
  const control = (
    center: readonly [number, number],
    band: StrokeBand,
  ): FontMorphSdfWarpControl => ({
    center: [center[0] / extent, center[1] / extent],
    radius: radius(band),
  })
  return {
    id: `auto-${source.orientation}-${index}`,
    source: control(sourceCenter, source),
    target: control(targetCenter, target),
  }
}

function registrationCandidates(pair: FontMorphSdfGlyphPair) {
  const candidates: { region: FontMorphSdfWarpRegion; cost: number }[] = []
  for (const orientation of ['horizontal', 'vertical'] as const) {
    const sourceBands = strokeBands(pair.source.distance, pair.size, orientation)
    const targetBands = strokeBands(pair.target.distance, pair.size, orientation)
    for (const [sourceIndex, source] of sourceBands.entries()) {
      for (const [targetIndex, target] of targetBands.entries()) {
        const sourceCenter = bandCenter(source)
        const targetCenter = bandCenter(target)
        const sourceLength = bandLength(source)
        const targetLength = bandLength(target)
        const lengthRatio =
          Math.max(sourceLength, targetLength) / Math.max(1, Math.min(sourceLength, targetLength))
        const crossDifference =
          Math.abs(
            sourceCenter[orientation === 'horizontal' ? 0 : 1] -
              targetCenter[orientation === 'horizontal' ? 0 : 1],
          ) / pair.size
        if (lengthRatio > 1.9 || crossDifference > 0.25) continue
        const axisDifference =
          Math.abs(
            sourceCenter[orientation === 'horizontal' ? 1 : 0] -
              targetCenter[orientation === 'horizontal' ? 1 : 0],
          ) / pair.size
        const rankDifference = Math.abs(
          sourceIndex / Math.max(1, sourceBands.length - 1) -
            targetIndex / Math.max(1, targetBands.length - 1),
        )
        const cost =
          axisDifference + crossDifference * 2 + Math.abs(Math.log(lengthRatio)) + rankDifference
        candidates.push({
          region: candidateRegion(source, target, pair.size, candidates.length),
          cost,
        })
      }
    }
  }
  return candidates
    .sort((left, right) => {
      if (left.cost !== right.cost) return left.cost - right.cost
      return left.region.id < right.region.id ? -1 : left.region.id > right.region.id ? 1 : 0
    })
    .slice(0, 12)
    .map(({ region }, index) => ({ ...region, id: `auto-${String(index).padStart(2, '0')}` }))
}

function featureRegistrationCandidates(pair: FontMorphSdfGlyphPair) {
  const extent = pair.size - 1
  const candidates: { region: FontMorphSdfWarpRegion; cost: number }[] = []
  for (const ink of [false, true]) {
    const sourceRegions = structuralRegions(pair.source.distance, pair.size, ink)
    const targetRegions = structuralRegions(pair.target.distance, pair.size, ink)
    if (sourceRegions.length !== targetRegions.length) continue
    const possibleMatches = sourceRegions.flatMap((source, sourceIndex) => {
      const sourceCenter = [
        (source.minX + source.maxX) / 2,
        (source.minY + source.maxY) / 2,
      ] as const
      return targetRegions.map((target, targetIndex) => {
        const targetCenter = [
          (target.minX + target.maxX) / 2,
          (target.minY + target.maxY) / 2,
        ] as const
        const movement = Math.hypot(
          targetCenter[0] - sourceCenter[0],
          targetCenter[1] - sourceCenter[1],
        )
        const areaRatio =
          Math.max(source.area, target.area) / Math.max(1, Math.min(source.area, target.area))
        return {
          source,
          target,
          sourceIndex,
          targetIndex,
          sourceCenter,
          targetCenter,
          movement,
          cost: movement / pair.size + Math.abs(Math.log(areaRatio)) * 0.35,
        }
      })
    })
    possibleMatches.sort(
      (left, right) =>
        left.cost - right.cost ||
        left.sourceIndex - right.sourceIndex ||
        left.targetIndex - right.targetIndex,
    )
    const matchedSources = new Set<number>()
    const matchedTargets = new Set<number>()
    for (const match of possibleMatches) {
      if (matchedSources.has(match.sourceIndex) || matchedTargets.has(match.targetIndex)) continue
      matchedSources.add(match.sourceIndex)
      matchedTargets.add(match.targetIndex)
      const sourceWidth = match.source.maxX - match.source.minX + 1
      const sourceHeight = match.source.maxY - match.source.minY + 1
      const targetWidth = match.target.maxX - match.target.minX + 1
      const targetHeight = match.target.maxY - match.target.minY + 1
      for (const radiusScale of ink ? [0.65, 0.9, 1.2, 1.6] : [1.6, 2.2, 3]) {
        const control = (
          center: readonly [number, number],
          width: number,
          height: number,
        ): FontMorphSdfWarpControl => ({
          center: [center[0] / extent, center[1] / extent],
          radius: [
            Math.min(1, (width * radiusScale + match.movement) / extent),
            Math.min(1, (height * radiusScale + match.movement) / extent),
          ],
        })
        candidates.push({
          cost: match.cost + radiusScale / 100,
          region: {
            id: `auto-feature-${ink ? 'ink' : 'counter'}-${match.sourceIndex}-${match.targetIndex}-${radiusScale}`,
            source: control(match.sourceCenter, sourceWidth, sourceHeight),
            target: control(match.targetCenter, targetWidth, targetHeight),
          },
        })
      }
    }
  }
  return candidates
    .sort(
      (left, right) =>
        left.cost - right.cost || left.region.id.localeCompare(right.region.id, 'en'),
    )
    .slice(0, 24)
    .map(({ region }, index) => ({
      ...region,
      id: `auto-feature-${String(index).padStart(2, '0')}`,
    }))
}

function transientAnomalies(pair: FontMorphSdfGlyphPair, range: TopologyRange) {
  const anomalies: TransientAnomaly[] = []
  const maximumComponents = Math.max(range.source.components, range.target.components)
  const maximumHoles = Math.max(range.source.holes, range.target.holes)
  for (const progress of VALIDATION_PROGRESS) {
    const frame = renderFontMorphSdfFrame(pair, progress)
    const signature = topologySignature(frame, pair.size)
    if (signature.components > maximumComponents) {
      for (const region of structuralRegions(frame, pair.size, true).slice(
        0,
        signature.components - maximumComponents,
      )) {
        anomalies.push({ ...region, kind: 'component', progress })
      }
    }
    if (signature.holes > maximumHoles) {
      for (const region of structuralRegions(frame, pair.size, false).slice(
        0,
        signature.holes - maximumHoles,
      )) {
        anomalies.push({ ...region, kind: 'hole', progress })
      }
    }
  }

  const merged: TransientAnomaly[] = []
  for (const anomaly of anomalies) {
    const centerX = (anomaly.minX + anomaly.maxX) / 2
    const centerY = (anomaly.minY + anomaly.maxY) / 2
    const match = merged.find((candidate) => {
      if (candidate.kind !== anomaly.kind) return false
      const candidateX = (candidate.minX + candidate.maxX) / 2
      const candidateY = (candidate.minY + candidate.maxY) / 2
      return Math.hypot(centerX - candidateX, centerY - candidateY) <= pair.size * 0.05
    })
    if (!match) {
      merged.push(anomaly)
    } else if (anomaly.area > match.area) {
      Object.assign(match, anomaly)
    }
  }
  return merged
    .sort((left, right) => right.area - left.area || left.progress - right.progress)
    .slice(0, 2)
}

function inkPixelComponents(field: ArrayLike<number>, size: number) {
  const visited = new Uint8Array(field.length)
  const components: number[][] = []
  for (let start = 0; start < field.length; start += 1) {
    if (visited[start] || field[start] <= 128) continue
    const pixels: number[] = []
    const queue = [start]
    visited[start] = 1
    while (queue.length) {
      const index = queue.pop()!
      pixels.push(index)
      const x = index % size
      const visit = (neighbor: number) => {
        if (visited[neighbor] || field[neighbor] <= 128) return
        visited[neighbor] = 1
        queue.push(neighbor)
      }
      if (x > 0) visit(index - 1)
      if (x + 1 < size) visit(index + 1)
      if (index >= size) visit(index - size)
      if (index + size < field.length) visit(index + size)
    }
    if (pixels.length >= minimumStructuralArea(size)) components.push(pixels)
  }
  return components.sort((left, right) => right.length - left.length || left[0] - right[0])
}

function closestPixelBridge(anchor: readonly number[], component: readonly number[], size: number) {
  const target = new Uint8Array(size * size)
  for (const index of component) target[index] = 1
  const visited = new Uint8Array(size * size)
  const origin = new Int32Array(size * size)
  origin.fill(-1)
  const queue = [...anchor]
  for (const index of anchor) {
    visited[index] = 1
    origin[index] = index
  }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]
    if (target[index]) return [origin[index], index] as const
    const x = index % size
    const visit = (neighbor: number) => {
      if (visited[neighbor]) return
      visited[neighbor] = 1
      origin[neighbor] = origin[index]
      queue.push(neighbor)
    }
    if (x > 0) visit(index - 1)
    if (x + 1 < size) visit(index + 1)
    if (index >= size) visit(index - size)
    if (index + size < target.length) visit(index + size)
  }
  return [anchor[0], component[0]] as const
}

function topologyRepairCandidates(pair: FontMorphSdfGlyphPair, range: TopologyRange) {
  const extent = pair.size - 1
  const candidates: FontMorphSdfWarpRegion[] = []
  for (const progress of VALIDATION_PROGRESS) {
    const frame = renderFontMorphSdfFrame(pair, progress)
    const signature = topologySignature(frame, pair.size)
    if (signature.components > Math.max(range.source.components, range.target.components)) {
      const components = inkPixelComponents(frame, pair.size)
      const anchor = components[0]
      for (const [componentIndex, component] of components.slice(1).entries()) {
        const [leftIndex, rightIndex] = closestPixelBridge(anchor, component, pair.size)
        const leftX = leftIndex % pair.size
        const leftY = Math.floor(leftIndex / pair.size)
        const rightX = rightIndex % pair.size
        const rightY = Math.floor(rightIndex / pair.size)
        const center = [(leftX + rightX) / 2, (leftY + rightY) / 2] as const
        const gap = Math.max(2, Math.hypot(rightX - leftX, rightY - leftY))
        for (const distanceBias of [8, 12, 16, 24, 32, 48, 64]) {
          for (const radiusScale of [1.5, 2.5, 4]) {
            const radius = Math.max(pair.size * 0.018, gap * radiusScale)
            const control: FontMorphSdfWarpControl = {
              center: [center[0] / extent, center[1] / extent],
              radius: [radius / extent, radius / extent],
            }
            candidates.push({
              id: `auto-repair-component-${progress}-${componentIndex}-${distanceBias}-${radiusScale}`,
              source: control,
              target: control,
              distanceBias,
            })
          }
        }
      }
    }
    if (
      signature.components < Math.min(range.source.components, range.target.components) ||
      signature.holes < Math.min(range.source.holes, range.target.holes)
    ) {
      const medial: { index: number; distance: number; disagreement: number }[] = []
      for (let y = 2; y < pair.size - 2; y += 1) {
        for (let x = 2; x < pair.size - 2; x += 1) {
          const index = y * pair.size + x
          const distance = frame[index] - 128
          if (distance <= 0 || distance > 48) continue
          let maximum = true
          for (let offsetY = -2; offsetY <= 2 && maximum; offsetY += 1) {
            for (let offsetX = -2; offsetX <= 2; offsetX += 1) {
              if (frame[index + offsetY * pair.size + offsetX] > frame[index]) {
                maximum = false
                break
              }
            }
          }
          if (!maximum) continue
          const disagreement =
            Math.abs(pair.source.distance[index] - pair.target.distance[index]) / 255
          medial.push({ index, distance, disagreement })
        }
      }
      const centers: typeof medial = []
      for (const candidate of medial.sort(
        (left, right) =>
          right.disagreement - left.disagreement ||
          left.distance - right.distance ||
          left.index - right.index,
      )) {
        const x = candidate.index % pair.size
        const y = Math.floor(candidate.index / pair.size)
        if (
          centers.some((center) => {
            const centerX = center.index % pair.size
            const centerY = Math.floor(center.index / pair.size)
            return Math.hypot(x - centerX, y - centerY) < pair.size * 0.055
          })
        ) {
          continue
        }
        centers.push(candidate)
        if (centers.length === 8) break
      }
      for (const [centerIndex, center] of centers.entries()) {
        const x = center.index % pair.size
        const y = Math.floor(center.index / pair.size)
        for (const distanceBias of [-12, -20, -32, -48, -64]) {
          for (const radiusScale of [0.02, 0.032, 0.05]) {
            const control: FontMorphSdfWarpControl = {
              center: [x / extent, y / extent],
              radius: [radiusScale, radiusScale],
            }
            candidates.push({
              id: `auto-repair-separation-${progress}-${centerIndex}-${distanceBias}-${radiusScale}`,
              source: control,
              target: control,
              distanceBias,
            })
          }
        }
      }
    }
  }
  return candidates
    .sort((left, right) => left.id.localeCompare(right.id, 'en'))
    .slice(0, 42)
    .map((region, index) => ({ ...region, id: `auto-repair-${String(index).padStart(2, '0')}` }))
}

function fieldValue(field: Uint8Array, size: number, x: number, y: number) {
  const column = Math.max(0, Math.min(size - 1, Math.round(x)))
  const row = Math.max(0, Math.min(size - 1, Math.round(y)))
  return field[row * size + column]
}

function localRegistrationCandidates(pair: FontMorphSdfGlyphPair, range: TopologyRange) {
  const extent = pair.size - 1
  const candidates: { region: FontMorphSdfWarpRegion; cost: number }[] = []
  for (const [anomalyIndex, anomaly] of transientAnomalies(pair, range).entries()) {
    const centerX = (anomaly.minX + anomaly.maxX) / 2
    const centerY = (anomaly.minY + anomaly.maxY) / 2
    const width = anomaly.maxX - anomaly.minX + 1
    const height = anomaly.maxY - anomaly.minY + 1
    const patchRadius = Math.max(
      Math.round(pair.size * 0.04),
      Math.ceil(Math.max(width, height) * 1.5),
    )
    const maximumShift = Math.max(2, Math.round(pair.size * 0.1))
    const searchStep = Math.max(1, Math.round(pair.size / 64))
    const sampleStep = Math.max(1, Math.round(patchRadius / 5))
    const shifts: { x: number; y: number; cost: number }[] = []
    for (let y = -maximumShift; y <= maximumShift; y += searchStep) {
      for (let x = -maximumShift; x <= maximumShift; x += searchStep) {
        if (x === 0 && y === 0) continue
        let difference = 0
        let samples = 0
        const sourceCenterX = centerX - anomaly.progress * x
        const sourceCenterY = centerY - anomaly.progress * y
        const targetCenterX = centerX + (1 - anomaly.progress) * x
        const targetCenterY = centerY + (1 - anomaly.progress) * y
        for (let patchY = -patchRadius; patchY <= patchRadius; patchY += sampleStep) {
          for (let patchX = -patchRadius; patchX <= patchRadius; patchX += sampleStep) {
            difference += Math.abs(
              fieldValue(
                pair.source.distance,
                pair.size,
                sourceCenterX + patchX,
                sourceCenterY + patchY,
              ) -
                fieldValue(
                  pair.target.distance,
                  pair.size,
                  targetCenterX + patchX,
                  targetCenterY + patchY,
                ),
            )
            samples += 1
          }
        }
        const movement = Math.hypot(x, y) / pair.size
        shifts.push({ x, y, cost: difference / samples + movement })
      }
    }
    shifts.sort((left, right) => left.cost - right.cost || left.y - right.y || left.x - right.x)
    for (const [shiftIndex, shift] of shifts.slice(0, 6).entries()) {
      for (const radiusScale of [1.5, 2.5]) {
        const radiusX = Math.max(pair.size * 0.06, width * radiusScale + Math.abs(shift.x))
        const radiusY = Math.max(pair.size * 0.06, height * radiusScale + Math.abs(shift.y))
        const control = (x: number, y: number): FontMorphSdfWarpControl => ({
          center: [Math.max(0, Math.min(1, x / extent)), Math.max(0, Math.min(1, y / extent))],
          radius: [Math.min(1, radiusX / extent), Math.min(1, radiusY / extent)],
        })
        candidates.push({
          cost: shift.cost + radiusScale / 100,
          region: {
            id: `auto-local-${anomalyIndex}-${shiftIndex}-${radiusScale}`,
            source: control(
              centerX - anomaly.progress * shift.x,
              centerY - anomaly.progress * shift.y,
            ),
            target: control(
              centerX + (1 - anomaly.progress) * shift.x,
              centerY + (1 - anomaly.progress) * shift.y,
            ),
          },
        })
      }
    }
  }
  return candidates
    .sort((left, right) => {
      if (left.cost !== right.cost) return left.cost - right.cost
      return left.region.id < right.region.id ? -1 : left.region.id > right.region.id ? 1 : 0
    })
    .slice(0, 12)
    .map(({ region }, index) => ({ ...region, id: `auto-local-${String(index).padStart(2, '0')}` }))
}

function selectRegistration(
  pair: FontMorphSdfGlyphPair,
  range: TopologyRange,
  selected: FontMorphSdfWarpRegion[],
  penalty: number,
  candidates: FontMorphSdfWarpRegion[],
  maximumCandidateAdditions = 3,
) {
  const initialCount = selected.length
  const maximumAdditions = Math.min(maximumCandidateAdditions, MAX_WARP_REGIONS - initialCount)
  let best = { selected, penalty }
  let frontier = [best]
  for (let depth = 0; depth < maximumAdditions && frontier.length; depth += 1) {
    const next = new Map<string, { selected: FontMorphSdfWarpRegion[]; penalty: number }>()
    for (const state of frontier) {
      const chosen = new Set(state.selected.map(({ id }) => id))
      for (const candidate of candidates) {
        if (chosen.has(candidate.id)) continue
        const candidateSelected = [...state.selected, candidate]
        const signature = candidateSelected
          .map(({ id }) => id)
          .sort()
          .join('|')
        if (next.has(signature)) continue
        const candidatePenalty = topologyPenalty(pair, candidateSelected, range)
        const candidateState = { selected: candidateSelected, penalty: candidatePenalty }
        next.set(signature, candidateState)
        if (
          candidatePenalty < best.penalty ||
          (candidatePenalty === best.penalty && candidateSelected.length < best.selected.length)
        ) {
          best = candidateState
        }
        if (candidatePenalty === 0) return candidateState
      }
    }
    frontier = [...next.values()]
      .sort(
        (left, right) =>
          left.penalty - right.penalty ||
          left.selected
            .map(({ id }) => id)
            .join('|')
            .localeCompare(right.selected.map(({ id }) => id).join('|'), 'en'),
      )
      .slice(0, 12)
  }
  return best
}

/**
 * Finds the smallest deterministic local registration that removes topology
 * outside the two endpoint signatures. Fonts and characters are never named
 * or special-cased; stable glyphs take the zero-region fast path.
 */
export function discoverSdfWarpRegions(pair: FontMorphSdfGlyphPair): FontMorphSdfWarpRegion[] {
  const range = {
    source: topologySignature(pair.source.distance, pair.size),
    target: topologySignature(pair.target.distance, pair.size),
  }
  let selected: FontMorphSdfWarpRegion[] = []
  let penalty = topologyPenalty(pair, selected, range)

  // The output-resolution field is authoritative. A smaller analysis grid can
  // make a narrow stroke or counter disappear through resampling, so never
  // apply its proposed repair when the actual field already satisfies the
  // endpoint topology. This rule is script- and glyph-independent.
  if (penalty === 0) return selected

  if (pair.size > MAX_ANALYSIS_SIZE) {
    try {
      const scale = pair.size / MAX_ANALYSIS_SIZE
      const regions: FontMorphSdfWarpRegion[] = discoverSdfWarpRegions(analysisPair(pair)).map(
        (region) => ({
          ...region,
          ...(region.distanceBias === undefined
            ? {}
            : { distanceBias: region.distanceBias * scale }),
        }),
      )
      if (topologyPenalty(pair, regions, range) === 0) return regions
    } catch {
      // Retry at the source field resolution below when a coarse feature is ambiguous.
    }
  }

  const simpleConnectedShape =
    range.source.components <= 1 &&
    range.target.components <= 1 &&
    range.source.holes === 0 &&
    range.target.holes === 0
  if (simpleConnectedShape) {
    ;({ selected, penalty } = selectRegistration(
      pair,
      range,
      selected,
      penalty,
      localRegistrationCandidates(pair, range),
      1,
    ))
  }
  ;({ selected, penalty } = selectRegistration(
    pair,
    range,
    selected,
    penalty,
    featureRegistrationCandidates(pair),
  ))
  ;({ selected, penalty } = selectRegistration(
    pair,
    range,
    selected,
    penalty,
    registrationCandidates(pair),
  ))
  if (penalty > 0) {
    ;({ selected, penalty } = selectRegistration(
      pair,
      range,
      selected,
      penalty,
      topologyRepairCandidates({ ...pair, warpRegions: selected }, range),
    ))
  }
  if (penalty > 0) {
    ;({ selected, penalty } = selectRegistration(
      pair,
      range,
      selected,
      penalty,
      localRegistrationCandidates({ ...pair, warpRegions: selected }, range),
    ))
  }
  if (penalty > 0) {
    const signatures = VALIDATION_PROGRESS.map((progress) => ({
      progress,
      signature: topologySignature(
        renderFontMorphSdfFrame({ ...pair, warpRegions: selected }, progress),
        pair.size,
      ),
    }))
    throw new RangeError(
      `Glyphflux could not automatically resolve intermediate topology for ${pair.unicode}: ${JSON.stringify({ range, signatures, penalty })}`,
    )
  }
  return selected
}
