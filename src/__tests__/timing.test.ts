import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_MORPH_DURATION_MS,
  easedOutlineProgress,
  endpointHandoffOpacities,
} from '../timing'

describe('endpoint handoff timing', () => {
  it('slows timed outlines to a stop without changing their endpoints or reversal', () => {
    expect(easedOutlineProgress(-1)).toBe(0)
    expect(easedOutlineProgress(0)).toBe(0)
    expect(easedOutlineProgress(1)).toBe(1)
    expect(easedOutlineProgress(2)).toBe(1)
    let previous = 0
    for (let step = 0; step <= 1_000; step += 1) {
      const progress = step / 1_000
      const eased = easedOutlineProgress(progress)
      expect(eased).toBeGreaterThanOrEqual(previous)
      expect(eased).toBeCloseTo(1 - easedOutlineProgress(1 - progress), 12)
      previous = eased
    }
    const frame = 1_000 / 60 / DEFAULT_FONT_MORPH_DURATION_MS
    const lastStep = 1 - easedOutlineProgress(1 - frame)
    const precedingStep =
      easedOutlineProgress(1 - frame) - easedOutlineProgress(1 - 2 * frame)
    expect(lastStep).toBeLessThan(precedingStep / 2)
    expect(lastStep).toBeLessThan(frame / 10)
  })

  it('uses one normalized, reversible layer selection for exact endpoints and the renderer', () => {
    for (const duration of [40, DEFAULT_FONT_MORPH_DURATION_MS, 2_000]) {
      for (let step = 0; step <= 1_000; step += 1) {
        const progress = step / 1_000
        const forward = endpointHandoffOpacities(progress, duration)
        const reverse = endpointHandoffOpacities(1 - progress, duration)
        expect(forward.source + forward.renderer + forward.destination).toBeCloseTo(1, 12)
        expect(forward.source).toBeCloseTo(reverse.destination, 12)
        expect(forward.renderer).toBeCloseTo(reverse.renderer, 12)
      }
    }
  })

  it('uses exact DOM text only at the endpoints and never cross-fades intermediate glyphs', () => {
    expect(endpointHandoffOpacities(0)).toEqual({ source: 1, renderer: 0, destination: 0 })
    expect(endpointHandoffOpacities(1)).toEqual({ source: 0, renderer: 0, destination: 1 })
    expect(endpointHandoffOpacities(0.001)).toEqual({
      source: 0,
      renderer: 1,
      destination: 0,
    })
    expect(endpointHandoffOpacities(0.79)).toEqual({
      source: 0,
      renderer: 1,
      destination: 0,
    })
    expect(endpointHandoffOpacities(0.999)).toEqual({
      source: 0,
      renderer: 1,
      destination: 0,
    })
  })
})
