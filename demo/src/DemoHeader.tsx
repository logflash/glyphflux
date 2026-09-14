import { languages } from './catalog'

interface DemoHeaderProps {
  locale: string
  title: string
  selectId: string
  onLocaleChange: (locale: string) => void
}

export function DemoHeader({ locale, title, selectId, onLocaleChange }: DemoHeaderProps) {
  return (
    <header className="demo-header">
      <div>
        <div className="eyebrow-row">
          <p className="eyebrow">Glyphflux</p>
          <a
            className="github-link"
            href="https://github.com/logflash/glyphflux"
            target="_blank"
            rel="noreferrer"
            aria-label="Glyphflux on GitHub"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.28-.36 6.72-1.61 6.72-7.25A5.65 5.65 0 0 0 19.22 3.3 5.4 5.4 0 0 0 19.08 1S17.9.65 15 2.48a13.38 13.38 0 0 0-7 0C5.1.65 3.92 1 3.92 1a5.4 5.4 0 0 0-.14 2.3 5.65 5.65 0 0 0-1.5 3.95c0 5.63 3.44 6.88 6.72 7.25A4.8 4.8 0 0 0 9 18v4" />
              <path d="M9 18c-4.51 2-5-2-7-2" />
            </svg>
          </a>
        </div>
        <h1>{title}</h1>
      </div>
      <label className="locale-control" htmlFor={selectId}>
        <span>Language</span>
        <select
          id={selectId}
          value={locale}
          onChange={(event) => onLocaleChange(event.target.value)}
        >
          {languages.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
      </label>
    </header>
  )
}
