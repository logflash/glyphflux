import { applyComputedCanvasTextStyle } from './canvasText'
import type { FontMorphProgressController } from '../../src'

const refreshFrameStorageKey = 'glyphflux:refresh-frame'

interface RefreshFrameBase {
  version: 2
  path: string
  viewportWidth: number
  pixelRatio: number
  image: string
  anchorLeft: number
  anchorTop: number
  anchorWidth: number
  anchorHeight: number
}

interface ControlledRefreshFrame extends RefreshFrameBase {
  kind: 'controlled'
  locale: string
  progress: number
}

interface ViewRefreshFrame extends RefreshFrameBase {
  kind: 'view'
}

type RefreshFrame = ControlledRefreshFrame | ViewRefreshFrame

function writeRefreshFrame(frame: RefreshFrame) {
  try {
    window.localStorage.setItem(refreshFrameStorageKey, JSON.stringify(frame))
  } catch {
    // A refresh falls back to the font-ready first-paint gate when storage is unavailable.
  }
}

function frameIdentity() {
  return {
    viewportWidth: window.innerWidth,
    pixelRatio: window.devicePixelRatio,
  }
}

function baseline(element: HTMLElement) {
  const marker = element.ownerDocument.createElement('i')
  marker.setAttribute('aria-hidden', 'true')
  marker.style.cssText =
    'display:inline-block;width:0;height:0;margin:0;padding:0;border:0;vertical-align:baseline;'
  element.append(marker)
  const value = marker.getBoundingClientRect().top
  marker.remove()
  return value
}

function drawText(
  context: CanvasRenderingContext2D,
  element: HTMLElement,
  origin: DOMRect,
  geometryElement: HTMLElement = element,
) {
  const text = element.textContent ?? ''
  const sourceBounds = geometryElement.getBoundingClientRect()
  const bounds = element.getBoundingClientRect()
  if (!text || sourceBounds.width <= 0 || sourceBounds.height <= 0 || bounds.width <= 0) return

  const style = getComputedStyle(element)
  const alpha = Number.parseFloat(style.opacity)
  if (alpha <= 0) return

  const scaleY = bounds.height / sourceBounds.height
  const sourceBaseline = baseline(geometryElement) - sourceBounds.top

  context.save()
  context.globalAlpha = Number.isFinite(alpha) ? alpha : 1
  context.fillStyle = style.color
  applyComputedCanvasTextStyle(context, style)
  context.textAlign = style.direction === 'rtl' ? 'right' : 'left'
  const measuredWidth = context.measureText(text).width
  const scaleX = bounds.width / Math.max(Number.EPSILON, measuredWidth)
  context.translate(bounds.left - origin.left, bounds.top - origin.top)
  context.scale(scaleX, scaleY)
  context.fillText(text, style.direction === 'rtl' ? measuredWidth : 0, sourceBaseline)
  context.restore()
}

function snapshotCanvas(bounds: DOMRect, density: number) {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bounds.width * density))
  canvas.height = Math.max(1, Math.round(bounds.height * density))
  const context = canvas.getContext('2d')
  if (!context) return null
  context.scale(canvas.width / bounds.width, canvas.height / bounds.height)
  return { canvas, context }
}

function snapshotAnchor(snapshot: HTMLCanvasElement, anchor: DOMRect) {
  return {
    image: snapshot.toDataURL('image/png'),
    anchorLeft: 0,
    anchorTop: 0,
    anchorWidth: anchor.width,
    anchorHeight: anchor.height,
  }
}

function drawRenderer(
  context: CanvasRenderingContext2D,
  snapshot: HTMLCanvasElement,
  renderer: HTMLCanvasElement,
  stageBounds: DOMRect,
  opacity: number,
) {
  const rendererBounds = renderer.getBoundingClientRect()
  if (rendererBounds.width <= 0 || rendererBounds.height <= 0 || opacity <= 0) return

  context.save()
  context.resetTransform()
  context.globalAlpha = opacity
  const sourceScaleX = renderer.width / rendererBounds.width
  const sourceScaleY = renderer.height / rendererBounds.height
  context.drawImage(
    renderer,
    (stageBounds.left - rendererBounds.left) * sourceScaleX,
    (stageBounds.top - rendererBounds.top) * sourceScaleY,
    stageBounds.width * sourceScaleX,
    stageBounds.height * sourceScaleY,
    0,
    0,
    snapshot.width,
    snapshot.height,
  )
  context.restore()
}

export function persistControlledRefreshFrame(
  locale: string,
  progress: number,
  controller: FontMorphProgressController | null,
) {
  const renderer = document.querySelector<HTMLCanvasElement>('canvas[data-font-morph-sdf]')
  const stage = document.querySelector<HTMLElement>('.stage')
  const source = document.querySelector<HTMLElement>('.source-endpoint .endpoint')
  const target = document.querySelector<HTMLElement>('.target-endpoint .endpoint')
  const exactSource = document.querySelector<HTMLElement>(
    '.source-endpoint .exact-endpoint',
  )
  const exactTarget = document.querySelector<HTMLElement>(
    '.target-endpoint .exact-endpoint',
  )
  if (!renderer || !stage || !source || !target || !exactSource || !exactTarget) return
  if (getComputedStyle(renderer).visibility !== 'visible') return

  const stageBounds = stage.getBoundingClientRect()
  const snapshot = snapshotCanvas(stageBounds, window.devicePixelRatio)
  if (!snapshot) return
  const { canvas, context } = snapshot

  if (controller?.renderer === 'sdf' && controller.element === renderer) {
    const originalOpacity = renderer.style.opacity
    const rendererOpacity = Number.parseFloat(getComputedStyle(renderer).opacity)
    const endpointOpacity = Number.parseFloat(getComputedStyle(source).opacity)
    const sourceHandoff = Number.parseFloat(getComputedStyle(exactSource).opacity)
    const targetHandoff = Number.parseFloat(getComputedStyle(exactTarget).opacity)
    try {
      controller.setProgress(0)
      drawRenderer(context, canvas, renderer, stageBounds, endpointOpacity)
      controller.setProgress(1)
      drawRenderer(context, canvas, renderer, stageBounds, endpointOpacity)
      controller.setProgress(progress)
      drawRenderer(
        context,
        canvas,
        renderer,
        stageBounds,
        Math.min(
          1,
          rendererOpacity + sourceHandoff + targetHandoff,
        ),
      )
    } finally {
      controller.setProgress(progress)
      renderer.style.opacity = originalOpacity
    }
  } else {
    drawText(context, source, stageBounds)
    drawText(context, target, stageBounds)
    drawText(context, exactSource, stageBounds, source)
    drawText(context, exactTarget, stageBounds, target)
    drawRenderer(
      context,
      canvas,
      renderer,
      stageBounds,
      Number.parseFloat(getComputedStyle(renderer).opacity),
    )
  }

  writeRefreshFrame({
    version: 2,
    kind: 'controlled',
    path: window.location.pathname,
    locale,
    progress,
    ...frameIdentity(),
    ...snapshotAnchor(canvas, stageBounds),
  })
}

export function persistViewRefreshFrame(heading: HTMLElement | null) {
  const position = heading?.closest<HTMLElement>('.view-heading-position')
  if (!heading || !position || !heading.hasAttribute('data-demo-ink-centered')) return

  const positionBounds = position.getBoundingClientRect()
  const headingBounds = heading.getBoundingClientRect()
  const snapshot = snapshotCanvas(headingBounds, window.devicePixelRatio)
  if (!snapshot) return
  drawText(snapshot.context, heading, headingBounds)

  writeRefreshFrame({
    version: 2,
    kind: 'view',
    path: window.location.pathname,
    ...frameIdentity(),
    ...snapshotAnchor(snapshot.canvas, headingBounds),
    anchorLeft: (headingBounds.left - positionBounds.left) / positionBounds.width,
    anchorTop: (headingBounds.top - positionBounds.top) / positionBounds.height,
    anchorWidth: headingBounds.width / positionBounds.width,
    anchorHeight: headingBounds.height / positionBounds.height,
  })
}

const restoredProperties = [
  '--demo-refresh-image',
  '--demo-refresh-left',
  '--demo-refresh-top',
  '--demo-refresh-width',
  '--demo-refresh-height',
  '--demo-refresh-progress-label',
]

export function clearRestoredRefreshFrame(kind: RefreshFrame['kind']) {
  const root = document.documentElement
  if (root.dataset.demoRefreshFrame !== kind) return
  delete root.dataset.demoRefreshFrame
  for (const property of restoredProperties) root.style.removeProperty(property)
}

export const refreshFrameBootstrap = `(()=>{try{const key='${refreshFrameStorageKey}';const frame=JSON.parse(localStorage.getItem(key)||'null');if(!frame||frame.version!==2||frame.path!==location.pathname||Math.abs(frame.viewportWidth-innerWidth)>1||frame.pixelRatio!==devicePixelRatio)return;const root=document.documentElement;const set=(name,value)=>root.style.setProperty(name,String(value));let anchor;if(frame.kind==='controlled'){const main=document.querySelector('main.demo');anchor=document.querySelector('.stage');if(!main||main.dataset.locale!==frame.locale||!anchor)return;set('--demo-refresh-progress-label',\`"\${Math.round(frame.progress*100)}%"\`);const input=document.querySelector('#progress');if(input)input.value=String(Math.round(frame.progress*1000))}else{anchor=document.querySelector('.view-heading-position');if(!document.querySelector('main.view-demo')||!anchor)return}const bounds=anchor.getBoundingClientRect();const left=frame.kind==='controlled'?bounds.left:bounds.left+frame.anchorLeft*bounds.width;const top=frame.kind==='controlled'?bounds.top:bounds.top+frame.anchorTop*bounds.height;const width=frame.kind==='controlled'?bounds.width:frame.anchorWidth*bounds.width;const height=frame.kind==='controlled'?bounds.height:frame.anchorHeight*bounds.height;root.dataset.demoRefreshFrame=frame.kind;set('--demo-refresh-image',\`url("\${frame.image}")\`);set('--demo-refresh-left',\`\${left}px\`);set('--demo-refresh-top',\`\${top}px\`);set('--demo-refresh-width',\`\${width}px\`);set('--demo-refresh-height',\`\${height}px\`)}catch{}})()`
