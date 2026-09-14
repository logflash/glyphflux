import { Link } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  createFontMorphProgressController,
  DEFAULT_FONT_MORPH_DURATION_MS,
  endpointHandoffOpacities,
  type FontMorphProgressController,
} from '../../src'
import { languageFor, profileFor, profileStyle } from './catalog'
import { configureDemoGlyphflux } from './configureGlyphflux'
import { DemoHeader } from './DemoHeader'
import { loadManifest, type DemoManifest } from './demoData'
import { clearRestoredRefreshFrame, persistControlledRefreshFrame } from './refreshFrame'
import { useInkCentering } from './useInkCentering'

interface Box {
  left: number
  top: number
  width: number
  height: number
}

function interpolate(source: number, target: number, progress: number) {
  return source + (target - source) * progress
}

function interpolatedBox(source: Box, target: Box, progress: number): Box {
  return {
    left: interpolate(source.left, target.left, progress),
    top: interpolate(source.top, target.top, progress),
    width: interpolate(source.width, target.width, progress),
    height: interpolate(source.height, target.height, progress),
  }
}

function positionExactEndpoint(element: HTMLElement | null, endpoint: Box, current: Box) {
  if (!element) return
  const scaleX = current.width / Math.max(Number.EPSILON, endpoint.width)
  const scaleY = current.height / Math.max(Number.EPSILON, endpoint.height)
  if (
    Math.abs(current.left - endpoint.left) < 0.001 &&
    Math.abs(current.top - endpoint.top) < 0.001 &&
    Math.abs(scaleX - 1) < 0.000_001 &&
    Math.abs(scaleY - 1) < 0.000_001
  ) {
    element.style.transform = 'none'
    return
  }
  element.style.transform = `translate3d(${current.left - endpoint.left}px, ${current.top - endpoint.top}px, 0) scale(${scaleX}, ${scaleY})`
}

interface SdfAppProps {
  initialLocale?: string
  onLocaleChange?: (locale: string) => void
}

const progressStorageKey = 'glyphflux:controlled-progress'

function storedProgress() {
  try {
    const stored = Number.parseFloat(window.localStorage.getItem(progressStorageKey) ?? '')
    if (Number.isFinite(stored)) return Math.min(1, Math.max(0, stored))
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return 0.5
}

function persistProgress(progress: number) {
  try {
    window.localStorage.setItem(progressStorageKey, String(progress))
  } catch {
    // The demo remains fully functional when persistent storage is unavailable.
  }
}

export function SdfApp({ initialLocale = 'en', onLocaleChange }: SdfAppProps) {
  const [data, setData] = useState<DemoManifest | null>(null)
  const [locale, setLocale] = useState(() => languageFor(initialLocale).code)
  const [progress, setProgress] = useState(0.5)
  const [layoutVersion, setLayoutVersion] = useState(0)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const stageRef = useRef<HTMLElement>(null)
  const sourceRef = useRef<HTMLSpanElement>(null)
  const targetRef = useRef<HTMLSpanElement>(null)
  const exactSourceRef = useRef<HTMLSpanElement>(null)
  const exactTargetRef = useRef<HTMLSpanElement>(null)
  const sourceStackRef = useRef<HTMLSpanElement>(null)
  const targetStackRef = useRef<HTMLSpanElement>(null)
  const controllerRef = useRef<FontMorphProgressController | null>(null)
  const frameVersionRef = useRef(0)
  const progressRef = useRef(progress)
  const language = languageFor(locale)
  const profile = profileFor(language)
  const sample = data?.samples[language.code]
  const handoff = endpointHandoffOpacities(progress, DEFAULT_FONT_MORPH_DURATION_MS)

  progressRef.current = progress
  useInkCentering(sourceRef, stageRef, sourceStackRef, `${locale}:source`)
  useInkCentering(targetRef, stageRef, targetStackRef, `${locale}:target`)

  useLayoutEffect(() => {
    const restored = storedProgress()
    progressRef.current = restored
    setProgress(restored)
  }, [])

  useEffect(() => setLocale(languageFor(initialLocale).code), [initialLocale])

  useEffect(() => {
    configureDemoGlyphflux()
    void loadManifest().then(setData, (reason: unknown) =>
      setError(reason instanceof Error ? reason.message : String(reason)),
    )
  }, [])

  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const update = () => setLayoutVersion((value) => value + 1)
    void document.fonts.ready.then(update)
    const observer = new ResizeObserver(update)
    observer.observe(stage)
    return () => observer.disconnect()
  }, [sample])

  useEffect(() => {
    if (!ready) return
    const persist = () =>
      persistControlledRefreshFrame(locale, progress, controllerRef.current)
    const timeout = window.setTimeout(persist, 150)
    window.addEventListener('beforeunload', persist)
    window.addEventListener('pagehide', persist)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('beforeunload', persist)
      window.removeEventListener('pagehide', persist)
    }
  }, [locale, progress, ready])

  useLayoutEffect(() => {
    const source = sourceRef.current
    const target = targetRef.current
    if (!source || !target || !sample) return

    let disposed = false
    setReady(false)
    setError('')
    controllerRef.current?.destroy()
    controllerRef.current = null
    configureDemoGlyphflux()

    void document.fonts.ready
      .then(() =>
        createFontMorphProgressController({
          source,
          target,
          initialProgress: progressRef.current,
        }),
      )
      .then(
        (controller) => {
          if (disposed) {
            controller.destroy()
            return
          }
          controller.element.style.visibility = 'hidden'
          controller.element.dataset.fontMorphSdf = ''
          controllerRef.current = controller
          setReady(true)
          setLayoutVersion((value) => value + 1)
        },
        (reason: unknown) => {
          if (!disposed) setError(reason instanceof Error ? reason.message : String(reason))
        },
      )

    return () => {
      disposed = true
      controllerRef.current?.destroy()
      controllerRef.current = null
    }
  }, [locale, sample])

  useLayoutEffect(() => {
    const controller = controllerRef.current
    const source = sourceRef.current
    const target = targetRef.current
    if (!controller || !source || !target) return

    controller.refresh()
    controller.setProgress(progress)
    controller.element.style.opacity = String(handoff.renderer)
    controller.element.style.visibility = ready ? 'visible' : 'hidden'
    frameVersionRef.current += 1
    controller.element.dataset.fontMorphSdfFrame = `${locale}:${progress}:${frameVersionRef.current}`

    const sourceBox = source.getBoundingClientRect()
    const targetBox = target.getBoundingClientRect()
    const currentBox = interpolatedBox(sourceBox, targetBox, progress)
    positionExactEndpoint(exactSourceRef.current, sourceBox, currentBox)
    positionExactEndpoint(exactTargetRef.current, targetBox, currentBox)
    clearRestoredRefreshFrame('controlled')
  }, [handoff.renderer, layoutVersion, locale, progress, ready])

  return (
    <main
      className="demo"
      data-demo-status={ready ? 'ready' : error ? 'error' : 'loading'}
      data-locale={locale}
      data-font-profile={language.profile}
      style={profileStyle(language)}
    >
      <DemoHeader
        locale={locale}
        title="Controlled transition"
        selectId="locale"
        onLocaleChange={(nextLocale) => {
          persistProgress(0)
          setProgress(0)
          setLocale(nextLocale)
          onLocaleChange?.(nextLocale)
        }}
      />
      <section ref={stageRef} className="stage" aria-label={`${language.label} font morph`}>
        <div className="endpoint-row">
          <span ref={sourceStackRef} className="endpoint-stack source-endpoint">
            <span
              ref={sourceRef}
              className="endpoint"
              data-demo-endpoint="source"
              lang={language.language ?? language.code}
              dir={language.direction}
            >
              {language.text}
            </span>
            <span
              ref={exactSourceRef}
              className="exact-endpoint"
              data-demo-exact-endpoint="source"
              lang={language.language ?? language.code}
              dir={language.direction}
              style={{ opacity: handoff.source }}
              aria-hidden="true"
            >
              {language.text}
            </span>
          </span>
          <span ref={targetStackRef} className="endpoint-stack target-endpoint">
            <span
              ref={targetRef}
              className="endpoint"
              data-demo-endpoint="target"
              lang={language.language ?? language.code}
              dir={language.direction}
            >
              {language.text}
            </span>
            <span
              ref={exactTargetRef}
              className="exact-endpoint"
              data-demo-exact-endpoint="target"
              lang={language.language ?? language.code}
              dir={language.direction}
              style={{ opacity: handoff.destination }}
              aria-hidden="true"
            >
              {language.text}
            </span>
          </span>
        </div>
        <div className="endpoint-caption source-caption">{profile.sourceLabel}</div>
        <div className="endpoint-caption target-caption">{profile.targetLabel}</div>
      </section>
      <div className="progress-control">
        <div className="progress-label">
          <label htmlFor="progress">Progress</label>
          <output key={ready ? 'ready' : 'loading'} htmlFor="progress">
            {Math.round(progress * 100)}%
          </output>
        </div>
        <input
          id="progress"
          type="range"
          min="0"
          max="1000"
          step="1"
          value={Math.round(progress * 1000)}
          aria-disabled={!ready}
          onChange={(event) => {
            const nextProgress = Number(event.target.value) / 1000
            persistProgress(nextProgress)
            setProgress(nextProgress)
          }}
        />
      </div>
      <p className="status" role="status">
        {error}
      </p>
      <Link
        className="demo-switch-link"
        to="/$language/view/$style"
        params={{ language: language.code, style: 'sans' }}
      >
        See the view transition demo
      </Link>
    </main>
  )
}
