export type FontMorphCompilerDiagnosticCode = 'INVALID_FONT' | 'UNSUPPORTED_SHAPING'

export class FontMorphCompilerError extends Error {
  readonly code: FontMorphCompilerDiagnosticCode
  readonly path: string

  constructor(code: FontMorphCompilerDiagnosticCode, path: string, message: string) {
    super(`${code} at ${path}: ${message}`)
    this.name = 'FontMorphCompilerError'
    this.code = code
    this.path = path
  }
}
