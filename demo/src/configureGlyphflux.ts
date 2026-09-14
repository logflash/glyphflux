import { configureFontMorph } from '../../src'
import { preparedManifestFor, profileList } from './demoData'

let configured = false

export function configureDemoGlyphflux() {
  if (configured || typeof document === 'undefined') return
  configured = true
  configureFontMorph({
    fontFiles: {
      sans: profileList.map(({ sourceFile }) => `/fonts/${sourceFile}`),
      serif: profileList.map(({ targetFile }) => `/fonts/${targetFile}`),
    },
    resolveFontFileIndex: (fontFamily, role) => {
      const normalized = fontFamily.toLowerCase()
      const index = profileList.findIndex((profile) =>
        normalized.includes(
          (role === 'sans' ? profile.sourceFamily : profile.targetFamily).toLowerCase(),
        ),
      )
      return index < 0 ? undefined : index
    },
    loadPreparedOutlines: preparedManifestFor,
  })
}
