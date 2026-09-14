/**
 * Return deterministic Unicode coverage for authored text and every code
 * point required by its canonical equivalents. Complex-script shapers may
 * decompose a precomposed character even when the original scalar is present.
 */
export function fontSubsetCoverage(...texts) {
  const canonicalText = texts
    .flat()
    .map((text) => `${text}${text.normalize('NFC')}${text.normalize('NFD')}`)
    .join('')
  return [...new Set(canonicalText)].join('')
}
