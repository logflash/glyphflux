import { describe, expect, it } from 'vitest'
import {
  DEFAULT_FONT_MORPH_DURATION_MS,
  endpointHandoffOpacities,
} from '../timing'

describe('endpoint handoff timing', () => {
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
