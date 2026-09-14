import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_FONT_MORPH_DURATION_MS, endpointHandoffOpacities } from '../dist/index.mjs'
import {
  renderFontMorphSdfAlphaFrame,
  renderFontMorphSdfFrame,
} from '../dist/sdf-runtime/index.mjs'

const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const generatedRoot = resolve(packageRoot, 'demo/public/generated')
const catalog = JSON.parse(await readFile(resolve(packageRoot, 'demo/catalog.json'), 'utf8'))
const manifest = JSON.parse(await readFile(resolve(generatedRoot, 'manifest.json'), 'utf8'))
const checkpoints = [
  0, 0.03, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.8, 0.875, 0.9, 0.97, 0.99,
  0.995, 1,
]
const temporalStep = 0.005
const pairFiles = new Map()
const pairUsage = new Map()

function decode(value) {
  return Uint8Array.from(Buffer.from(value, 'base64'))
}

function deserialize(serialized) {
  return {
    ...serialized,
    source: { ...serialized.source, distance: decode(serialized.source.distanceBase64) },
    target: { ...serialized.target, distance: decode(serialized.target.distanceBase64) },
  }
}

function reversePair(pair) {
  return {
    ...pair,
    source: pair.target,
    target: pair.source,
    warpRegions: pair.warpRegions.map((region) => ({
      ...region,
      source: region.target,
      target: region.source,
    })),
  }
}

function expectedEndpointAlpha(distance) {
  return Uint8ClampedArray.from(distance, (value) =>
    Math.round(Math.max(0, Math.min(1, 0.5 + (value - 128) / 4)) * 255),
  )
}

function difference(left, right) {
  let total = 0
  for (let index = 0; index < left.length; index += 1) {
    total += Math.abs(left[index] - right[index])
  }
  return total
}

function compositedFrame(
  source,
  renderer,
  target,
  progress,
  output = new Uint8ClampedArray(renderer.length),
) {
  const handoff = endpointHandoffOpacities(progress, DEFAULT_FONT_MORPH_DURATION_MS)
  for (let index = 0; index < renderer.length; index += 1) {
    output[index] = Math.min(
      255,
      Math.round(
        source[index] * handoff.source +
          renderer[index] * handoff.renderer +
          target[index] * handoff.destination,
      ),
    )
  }
  return output
}

function metrics(alpha, size) {
  let mass = 0
  let weightedX = 0
  let weightedY = 0
  for (let index = 0; index < alpha.length; index += 1) {
    const weight = alpha[index] / 255
    mass += weight
    weightedX += (index % size) * weight
    weightedY += Math.floor(index / size) * weight
  }
  return {
    mass,
    center: mass ? [weightedX / mass, weightedY / mass] : null,
    ...structuralTopology(alpha, size),
  }
}

function structuralTopology(alpha, size) {
  const minimumArea = Math.max(2, Math.floor((size * size) / 4096))
  const foreground = Uint8Array.from(alpha, (value) => (value > 128 ? 1 : 0))
  const flood = (start, ink, visited) => {
    const queue = [start]
    visited[start] = 1
    let area = 0
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor]
      area += 1
      const x = index % size
      const visit = (next) => {
        if (visited[next] || foreground[next] !== ink) return
        visited[next] = 1
        queue.push(next)
      }
      if (x > 0) visit(index - 1)
      if (x + 1 < size) visit(index + 1)
      if (index >= size) visit(index - size)
      if (index + size < alpha.length) visit(index + size)
    }
    return area
  }

  const inkVisited = new Uint8Array(alpha.length)
  let components = 0
  for (let index = 0; index < alpha.length; index += 1) {
    if (inkVisited[index] || !foreground[index]) continue
    if (flood(index, 1, inkVisited) >= minimumArea) components += 1
  }

  const backgroundVisited = new Uint8Array(alpha.length)
  const visitExterior = (index) => {
    if (!backgroundVisited[index] && !foreground[index]) flood(index, 0, backgroundVisited)
  }
  for (let coordinate = 0; coordinate < size; coordinate += 1) {
    visitExterior(coordinate)
    visitExterior((size - 1) * size + coordinate)
    visitExterior(coordinate * size)
    visitExterior(coordinate * size + size - 1)
  }
  let holes = 0
  for (let index = 0; index < alpha.length; index += 1) {
    if (backgroundVisited[index] || foreground[index]) continue
    if (flood(index, 0, backgroundVisited) >= minimumArea) holes += 1
  }
  return { components, holes }
}

function assertCloseCenters(left, right, maximum, message) {
  if (!left || !right) return
  assert(Math.hypot(left[0] - right[0], left[1] - right[1]) <= maximum, message)
}

for (const language of catalog.languages) {
  const locale = language.code
  const sample = manifest.samples[locale]
  assert(sample, `${locale}: missing generated manifest entry`)
  assert.equal(sample.sourceRun.glyphs.length, sample.targetRun.glyphs.length)
  for (let index = 0; index < sample.sourceRun.glyphs.length; index += 1) {
    assert.equal(
      sample.sourceRun.glyphs[index].key,
      sample.targetRun.glyphs[index].key,
      `${locale}: shaped clusters must retain semantic correspondence`,
    )
  }

  let usage = pairUsage.get(sample.pair)
  if (!usage) {
    usage = { keys: new Set(), locales: new Set() }
    pairUsage.set(sample.pair, usage)
  }
  usage.locales.add(locale)
  for (const glyph of sample.sourceRun.glyphs) {
    const key = glyph.key ?? glyph.unicode
    if (key) usage.keys.add(key)
  }
}

let verifiedGlyphs = 0
let widestCoverageBand = { distance: 0, label: '', progress: 0 }
for (const [pairFile, usage] of pairUsage) {
  let serializedPairs = pairFiles.get(pairFile)
  if (!serializedPairs) {
    serializedPairs = JSON.parse(
      await readFile(resolve(generatedRoot, 'pairs', `${pairFile}.json`), 'utf8'),
    )
    pairFiles.set(pairFile, serializedPairs)
  }

  for (const key of usage.keys) {
    const serialized = serializedPairs.glyphs[key]
    assert(serialized, `${pairFile}:${key}: missing generated glyph pair`)
    const pair = deserialize(serialized)
    const label = `${[...usage.locales].join(',')}:${pair.unicode || key}`
    const pureFrames = checkpoints.map((progress) => renderFontMorphSdfAlphaFrame(pair, progress))
    const frames = pureFrames.map((frame, index) =>
      compositedFrame(pureFrames[0], frame, pureFrames.at(-1), checkpoints[index]),
    )
    const reverse = reversePair(pair)

    assert.deepEqual(
      frames[0],
      expectedEndpointAlpha(pair.source.distance),
      `${label}: source endpoint`,
    )
    assert.deepEqual(
      frames.at(-1),
      expectedEndpointAlpha(pair.target.distance),
      `${label}: target endpoint`,
    )

    const endpointDifference = difference(pureFrames[0], pureFrames.at(-1))
    const fieldEndpointDifference = difference(pair.source.distance, pair.target.distance)
    const targetFieldErrors = new Map()
    const sourceFieldErrors = new Map()
    for (let step = 0; step <= Math.round(1 / temporalStep); step += 1) {
      const progress = Number((step * temporalStep).toFixed(6))
      const frame = renderFontMorphSdfAlphaFrame(pair, progress)
      const field = renderFontMorphSdfFrame(pair, progress)
      const reversed = renderFontMorphSdfAlphaFrame(reverse, 1 - progress)
      const composite = compositedFrame(pureFrames[0], frame, pureFrames.at(-1), progress)
      const reverseDifference = difference(frame, reversed)
      assert(
        reverseDifference <= 1,
        `${label}: reverse playback differs by ${reverseDifference} alpha units at ${progress}`,
      )
      if (checkpoints.includes(progress)) {
        const reverseComposite = compositedFrame(
          pureFrames.at(-1),
          reversed,
          pureFrames[0],
          1 - progress,
        )
        const compositeReverseDifference = difference(composite, reverseComposite)
        assert(
          compositeReverseDifference <= 1,
          `${label}: composited reverse playback differs by ${compositeReverseDifference} alpha units at ${progress}`,
        )
      }
      for (let pixel = 0; pixel < frame.length; pixel += 1) {
        if (frame[pixel] === 0 || frame[pixel] === 255) continue
        const distance = Math.abs(field[pixel] - 128)
        if (distance > widestCoverageBand.distance) {
          widestCoverageBand = { distance, label, progress }
        }
        assert(
          distance <= 2.01,
          `${label}: translucent coverage escaped the spatial SDF edge by ${distance.toFixed(3)} at ${progress}`,
        )
      }
      if ([0.005, 0.01, 0.99, 0.995].includes(progress)) {
        sourceFieldErrors.set(progress, difference(field, pair.source.distance))
        targetFieldErrors.set(progress, difference(field, pair.target.distance))
      }
    }
    if (fieldEndpointDifference > 0) {
      assert(
        sourceFieldErrors.get(0.005) <= sourceFieldErrors.get(0.01) * 0.35 + 1,
        `${label}: source field must approach t=0 with zero velocity`,
      )
      assert(
        targetFieldErrors.get(0.995) <= targetFieldErrors.get(0.99) * 0.35 + 1,
        `${label}: target field must approach t=1 with zero velocity`,
      )
    }

    if (endpointDifference > 0) {
      const targetErrors = frames.map((frame) => difference(frame, frames.at(-1)))
      const nearTargetStart = checkpoints.indexOf(0.5)
      for (let index = nearTargetStart + 1; index < checkpoints.length; index += 1) {
        assert(
          targetErrors[index] <= targetErrors[index - 1] + 255,
          `${label}: target error must converge monotonically at ${checkpoints[index]}`,
        )
      }
      assert(
        targetErrors[checkpoints.indexOf(0.97)] / endpointDifference <= 0.05,
        `${label}: 97% frame must be within 5% of its target`,
      )
      assert(
        targetErrors[checkpoints.indexOf(0.99)] / endpointDifference <= 0.015,
        `${label}: 99% frame must be within 1.5% of its target`,
      )
      const sourceError = difference(frames[checkpoints.indexOf(0.03)], frames[0])
      assert(
        sourceError / endpointDifference <= 0.05,
        `${label}: 3% frame must remain near its source`,
      )
    }

    const measurements = frames.map((frame) => metrics(frame, pair.size))
    const sourceMetrics = measurements[0]
    const targetMetrics = measurements.at(-1)
    const maximumMass = Math.max(sourceMetrics.mass, targetMetrics.mass)
    const minimumMass = Math.min(sourceMetrics.mass, targetMetrics.mass)
    for (const [index, measurement] of measurements.entries()) {
      assert(
        measurement.mass <= maximumMass * 1.05 + 1,
        `${label}: apparent weight must not overshoot both endpoints at ${checkpoints[index]}`,
      )
      assert(
        measurement.mass >= minimumMass * 0.9 - 1,
        `${label}: apparent weight must not collapse below both endpoints at ${checkpoints[index]}`,
      )
      assert(
        measurement.components <= Math.max(sourceMetrics.components, targetMetrics.components),
        `${label}: must not hallucinate a structural component at ${checkpoints[index]}`,
      )
      assert(
        measurement.holes >= Math.min(sourceMetrics.holes, targetMetrics.holes) &&
          measurement.holes <= Math.max(sourceMetrics.holes, targetMetrics.holes),
        `${label}: counters must stay within endpoint topology at ${checkpoints[index]}`,
      )
    }
    assertCloseCenters(
      measurements[checkpoints.indexOf(0.97)].center,
      targetMetrics.center,
      1.5,
      `${label}: 97% visible ink must converge on the target position`,
    )
    assertCloseCenters(
      measurements[checkpoints.indexOf(0.99)].center,
      targetMetrics.center,
      0.5,
      `${label}: 99% visible ink must converge on the target position`,
    )
    verifiedGlyphs += 1
  }
}

console.log(
  `Glyphflux continuity passed for ${catalog.languages.length} languages and ${verifiedGlyphs} unique generated glyphs; translucent coverage stayed within ${widestCoverageBand.distance.toFixed(3)} field units of the moving boundary (worst: ${widestCoverageBand.label}:${widestCoverageBand.progress})`,
)
