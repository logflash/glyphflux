import {
  FONT_MORPH_RECORD_EVENT,
  beginFontMorph,
  configureFontMorph,
  createFontMorphFrameRenderer,
  prepareFontMorph,
  prepareFontMorphFrames,
  type FontMorphRecording,
} from '../dist/index.mjs'

declare global {
  interface Window {
    fontMorphFixture: {
      events: unknown[]
      workerRequests: unknown[]
      prepare: () => Promise<void>
      prepareUnknown: () => Promise<void>
      begin: () => boolean
      simulateBrowserTextScaling: () => void
      moveDestination: () => void
      reverse: () => boolean
      prepareReplay: () => Promise<void>
      replayAt: (time: number) => { advanceTo: number } | undefined
      show: (role: 'sans' | 'serif') => void
      stopReplay: () => void
    }
  }
}

const workerRequests: unknown[] = []

configureFontMorph({
  fontFiles: {
    sans: ['/sans-outline.otf'],
    serif: ['/serif-outline.otf'],
  },
  loadPreparedOutlines: () =>
    fetch('/prepared.json').then((response) => response.json()),
  createWorker: () => {
    const worker = new Worker('/outline-worker.js', { type: 'module' })
    const postMessage = worker.postMessage.bind(worker)
    worker.postMessage = ((message: unknown) => {
      workerRequests.push(message)
      postMessage(message)
    }) as typeof worker.postMessage
    return worker
  },
  resolveFontRole: (family) => (family.includes('Fixture Serif') ? 'serif' : 'sans'),
})

const events: unknown[] = []
const renderFrame = createFontMorphFrameRenderer()
window.addEventListener(FONT_MORPH_RECORD_EVENT, (event) => {
  const payload = (event as CustomEvent).detail
  events.push(payload)
})

function endpoint(role: 'sans' | 'serif', content = 'ee') {
  const element = document.createElement('span')
  element.dataset.fontMorph = 'sample'
  element.className = `endpoint ${role}`
  element.textContent = content
  return element
}

function swap(role: 'sans' | 'serif') {
  document.querySelector<HTMLElement>('[data-font-morph="sample"]')?.replaceWith(endpoint(role))
}

window.fontMorphFixture = {
  events,
  workerRequests,
  prepare: () => prepareFontMorph('sample'),
  prepareUnknown: async () => {
    document.querySelector<HTMLElement>('[data-font-morph="sample"]')?.replaceWith(
      endpoint('sans', 'e'),
    )
    await prepareFontMorph('sample')
  },
  begin: () => beginFontMorph('sample'),
  simulateBrowserTextScaling: () => {
    document.documentElement.classList.add('simulated-mobile-text-scaling')
  },
  moveDestination: () => {
    document.querySelector<HTMLElement>('[data-font-morph="sample"]')?.classList.add('moved')
  },
  reverse: () => {
    const started = beginFontMorph('sample')
    if (started) swap('sans')
    return started
  },
  prepareReplay: () => {
    const payload = events.at(-1) as FontMorphRecording | undefined
    const serifEndpoint = payload?.source.style.fontRole === 'serif' ? payload.source : payload?.target
    if (serifEndpoint) serifEndpoint.style.fontSizeToHeight *= 1.00004
    if (!payload) return Promise.resolve()
    return prepareFontMorphFrames(
      [
        {
          payload,
          text: payload.source.text,
          captureFrame: {
            screen: {
              left: 0,
              top: 0,
              width: window.innerWidth,
              height: window.innerHeight,
            },
            logicalWidth: window.innerWidth,
            logicalHeight: window.innerHeight,
          },
        },
      ],
      document,
    )
  },
  replayAt: (time) => {
    const payload = events.at(-1) as FontMorphRecording | undefined
    if (!payload) return undefined
    return renderFrame({
      document,
      payload,
      text: payload.source.text,
      progress: time / payload.duration,
      phase: time < payload.duration ? 'active' : 'settled',
      overlayRoot: document.getElementById('replay-overlay'),
    })
  },
  show: swap,
  stopReplay: () =>
    renderFrame({
      document: null,
      payload: null,
      text: '',
      progress: 0,
      phase: 'idle',
    }),
}
