export function applyComputedCanvasTextStyle(
  context: CanvasRenderingContext2D,
  style: CSSStyleDeclaration,
) {
  const fontParts = [
    style.fontStyle === 'normal' ? '' : style.fontStyle,
    style.fontVariantCaps === 'normal' ? '' : style.fontVariantCaps,
    style.fontWeight === 'normal' || style.fontWeight === '400' ? '' : style.fontWeight,
    style.fontStretch === 'normal' || style.fontStretch === '100%' ? '' : style.fontStretch,
    style.fontSize,
    style.fontFamily,
  ].filter(Boolean)

  context.font = fontParts.join(' ')
  context.direction = style.direction as CanvasDirection
  context.textBaseline = 'alphabetic'
  context.fontKerning = style.fontKerning as CanvasFontKerning
  context.fontStretch = style.fontStretch as CanvasFontStretch
  context.fontVariantCaps = style.fontVariantCaps as CanvasFontVariantCaps
  context.letterSpacing = style.letterSpacing
  context.wordSpacing = style.wordSpacing
}
