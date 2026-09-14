/** Locale-independent UTF-16 ordering for byte-stable compiler output. */
export function compareStableText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareStableText(left, right))
      .map(([key, entry]) => [key, normalized(entry)]),
  )
}

/** Stable JSON serialization used for hashes and compiler output. */
export function stableStringify(value: unknown, space?: number) {
  return JSON.stringify(normalized(value), null, space)
}
