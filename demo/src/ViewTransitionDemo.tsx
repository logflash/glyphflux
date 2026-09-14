import { Link } from '@tanstack/react-router'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { beginFontMorph, prepareFontMorph } from '../../src'
import { configureDemoGlyphflux } from './configureGlyphflux'
import { languageFor, profileFor, profileStyle } from './catalog'
import { DemoHeader } from './DemoHeader'
import { persistViewRefreshFrame } from './refreshFrame'
import { useInkCentering } from './useInkCentering'

const transitionKey = 'glyphflux-route-heading'
const routeCopy = {
  sans: {
    heading: 'One string, ready to morph.',
    body: 'Glyph correspondence is precomputed at build time, then served as compact data that browsers reconstruct with little runtime overhead.',
  },
  serif: {
    heading: 'One morph, smoothly executed.',
    body: 'Position, scale, color, and glyph structure morph together while the surrounding route updates.',
  },
} as const

interface ViewTransitionDemoProps {
  locale: string
  fontRole: 'sans' | 'serif'
  onNavigate: (fontRole: 'sans' | 'serif') => void
  onLocaleChange: (locale: string) => void
}

export function ViewTransitionDemo({
  locale,
  fontRole,
  onNavigate,
  onLocaleChange,
}: ViewTransitionDemoProps) {
  const language = languageFor(locale)
  const profile = profileFor(language)
  const [moving, setMoving] = useState(false)
  const headingPositionRef = useRef<HTMLDivElement>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const nextRole = fontRole === 'sans' ? 'serif' : 'sans'

  useInkCentering(
    headingRef,
    headingPositionRef,
    headingRef,
    `${language.code}:${fontRole}`,
  )

  useLayoutEffect(() => {
    configureDemoGlyphflux()
  }, [])

  useEffect(() => {
    setMoving(false)
    void prepareFontMorph(transitionKey)
  }, [fontRole, locale])

  useEffect(() => {
    const persist = () => persistViewRefreshFrame(headingRef.current)
    const timeout = window.setTimeout(persist, 150)
    window.addEventListener('beforeunload', persist)
    window.addEventListener('pagehide', persist)
    return () => {
      window.clearTimeout(timeout)
      window.removeEventListener('beforeunload', persist)
      window.removeEventListener('pagehide', persist)
    }
  }, [fontRole, locale])

  const navigate = async () => {
    if (moving) return
    setMoving(true)
    await prepareFontMorph(transitionKey)
    beginFontMorph(transitionKey)
    onNavigate(nextRole)
  }

  return (
    <main
      className={`view-demo ${fontRole}`}
      data-view-demo={fontRole}
      data-font-profile={language.profile}
      style={profileStyle(language)}
    >
      <DemoHeader
        locale={language.code}
        title="View transition"
        selectId="view-locale"
        onLocaleChange={onLocaleChange}
      />
      <section className="view-demo-scene">
        <div ref={headingPositionRef} className={`view-heading-position ${fontRole}`}>
          <h1
            key={fontRole}
            ref={headingRef}
            className={`view-heading ${fontRole}`}
            data-font-morph={transitionKey}
            lang={language.language ?? language.code}
            dir={language.direction}
          >
            {language.text}
          </h1>
        </div>
        <div className="view-demo-copy-stack">
          {(['sans', 'serif'] as const).map((role) => (
            <div
              key={role}
              className={`view-demo-copy${role === fontRole ? ' active' : ''}`}
              aria-hidden={role !== fontRole}
            >
              <h2>{routeCopy[role].heading}</h2>
              <p>{routeCopy[role].body}</p>
            </div>
          ))}
        </div>
        <div className="view-demo-action">
          <button type="button" disabled={moving} onClick={() => void navigate()}>
            Morph to {nextRole === 'serif' ? profile.targetLabel : profile.sourceLabel}
          </button>
        </div>
      </section>
      <Link
        className="demo-switch-link"
        to="/$language"
        params={{ language: language.code }}
      >
        See the controlled transition demo
      </Link>
    </main>
  )
}
