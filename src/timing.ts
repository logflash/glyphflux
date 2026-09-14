export const DEFAULT_FONT_MORPH_DURATION_MS = 760
export const FONT_MORPH_ENDPOINT_HANDOFF_MS = 0

function clamp(value: number) {
  return Math.min(1, Math.max(0, value))
}

/**
 * Keeps the generated morph fully visible between its exact DOM endpoints.
 * Endpoint text is never cross-faded over an intermediate glyph: that would
 * hide correspondence defects instead of morphing them. The replacement is
 * safe only at t=0 or t=1, where generated geometry is required to match the
 * corresponding authored text.
 */
export function endpointHandoffOpacities(
  progress: number,
  duration = DEFAULT_FONT_MORPH_DURATION_MS,
  hasSource = true,
  hasDestination = true,
) {
  void duration
  const normalized = clamp(progress)
  const source = normalized === 0 && hasSource ? 1 : 0
  const destination = normalized === 1 && hasDestination ? 1 : 0
  return {
    source,
    renderer: source || destination ? 0 : 1,
    destination,
  }
}
