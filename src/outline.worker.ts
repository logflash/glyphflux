import {
  createFontMorphCompiler,
  type FontMorphCompileRequest,
  type FontMorphFontRole,
} from './index'

interface CompileMessage extends FontMorphCompileRequest {
  id: number
  fontFiles: Record<FontMorphFontRole, readonly string[]>
}

interface WorkerScope {
  onmessage: ((event: MessageEvent<CompileMessage>) => void) | null
  postMessage: (message: unknown) => void
}

const scope = globalThis as unknown as WorkerScope
const buffers = new Map<string, Promise<ArrayBuffer>>()
let primaryCompilerPromise: ReturnType<typeof createFontMorphCompiler> | undefined
let fallbackCompilerPromise: ReturnType<typeof createFontMorphCompiler> | undefined

function loadBuffer(url: string) {
  let pending = buffers.get(url)
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) throw new Error(`Unable to load font outlines: ${response.status}`)
      return response.arrayBuffer()
    })
    buffers.set(url, pending)
  }
  return pending
}

scope.onmessage = (event) => {
  const { id, text, source, target, fontFiles } = event.data
  const request = { text, source, target }
  primaryCompilerPromise ??= Promise.all([
    Promise.all(fontFiles.sans.slice(0, 1).map(loadBuffer)),
    Promise.all(fontFiles.serif.slice(0, 1).map(loadBuffer)),
  ]).then(([sans, serif]) => createFontMorphCompiler({ sans, serif }))

  void primaryCompilerPromise
    .then(async (compilePrimary) => {
      let outline = Object.values(compilePrimary([request]).outlines)[0]
      const hasFallbackFaces = fontFiles.sans.length > 1 || fontFiles.serif.length > 1
      if (outline.fallback === 'unsupported-glyph' && hasFallbackFaces) {
        fallbackCompilerPromise ??= Promise.all([
          Promise.all(fontFiles.sans.map(loadBuffer)),
          Promise.all(fontFiles.serif.map(loadBuffer)),
        ]).then(([sans, serif]) => createFontMorphCompiler({ sans, serif }))
        const compileFallback = await fallbackCompilerPromise
        outline = Object.values(compileFallback([request]).outlines)[0]
      }
      scope.postMessage({ id, outline })
    })
    .catch((error: unknown) => {
      scope.postMessage({ id, error: error instanceof Error ? error.message : String(error) })
    })
}
