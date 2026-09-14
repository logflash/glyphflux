import type { RefObject } from 'react'
import { useLayoutEffect } from 'react'
import { applyComputedCanvasTextStyle } from './canvasText'
import { clearRestoredRefreshFrame } from './refreshFrame'

function centerVisibleInk(
  text: HTMLElement,
  container: HTMLElement,
  shifted: HTMLElement,
) {
  const style = getComputedStyle(text)
  const context = text.ownerDocument.createElement('canvas').getContext('2d')
  if (!context) return
  applyComputedCanvasTextStyle(context, style)
  const metrics = context.measureText(text.textContent ?? '')

  const marker = text.ownerDocument.createElement('i')
  marker.setAttribute('aria-hidden', 'true')
  marker.style.cssText =
    'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;'
  text.append(marker)
  const baseline = marker.getBoundingClientRect().top
  marker.remove()

  const currentCenter =
    baseline + (metrics.actualBoundingBoxDescent - metrics.actualBoundingBoxAscent) / 2
  const bounds = container.getBoundingClientRect()
  const desiredCenter = bounds.top + bounds.height / 2
  const currentOffset =
    Number.parseFloat(getComputedStyle(shifted).getPropertyValue('--demo-ink-offset')) || 0
  const nextOffset = currentOffset + desiredCenter - currentCenter
  if (!Number.isFinite(nextOffset)) return
  shifted.dataset.demoInkOffset = String(nextOffset)
  shifted.style.setProperty('--demo-ink-offset', `${nextOffset}px`)
}

function canvasFont(text: HTMLElement) {
  const context = text.ownerDocument.createElement('canvas').getContext('2d')
  if (!context) return null
  applyComputedCanvasTextStyle(context, getComputedStyle(text))
  return context.font
}

export function useInkCentering(
  textRef: RefObject<HTMLElement | null>,
  containerRef: RefObject<HTMLElement | null>,
  shiftedRef: RefObject<HTMLElement | null>,
  identity: string,
) {
  useLayoutEffect(() => {
    const text = textRef.current
    const container = containerRef.current
    const shifted = shiftedRef.current
    if (!text || !container || !shifted) return
    let current = true
    shifted.removeAttribute('data-demo-ink-centered')

    const update = (reveal = false) => {
      if (!current) return
      centerVisibleInk(text, container, shifted)
      if (reveal) {
        shifted.dataset.demoInkCentered = ''
        clearRestoredRefreshFrame('view')
      }
    }
    const refresh = () => update()
    const fonts = text.ownerDocument.fonts
    const font = canvasFont(text)
    const content = text.textContent ?? ''
    if (!font || (fonts.status === 'loaded' && fonts.check(font, content))) {
      update(true)
    } else {
      void fonts.load(font, content).catch(() => undefined)
      void fonts.ready.then(() => update(true))
    }

    const observer = new ResizeObserver(refresh)
    observer.observe(container)
    text.ownerDocument.defaultView?.addEventListener('resize', refresh)
    return () => {
      current = false
      observer.disconnect()
      text.ownerDocument.defaultView?.removeEventListener('resize', refresh)
      shifted.removeAttribute('data-demo-ink-centered')
    }
  }, [containerRef, identity, shiftedRef, textRef])
}
