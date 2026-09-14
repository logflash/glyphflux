import { createProcessor } from '@mdx-js/mdx'
import fg from 'fast-glob'
import { readFile } from 'node:fs/promises'
import { relative } from 'node:path'
import type {
  GlyphfluxDocumentConfig,
  GlyphfluxMdxSelector,
  LoadedGlyphfluxConfig,
} from './config'

interface MdxAttribute {
  type: string
  name?: string
  value?: string | null | { type?: string; value?: string }
}

interface MdxNode {
  type: string
  value?: string
  depth?: number
  name?: string
  attributes?: MdxAttribute[]
  children?: MdxNode[]
}

export interface GlyphfluxDiscoveredText {
  sources: string[]
  targets: string[]
  files: string[]
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0
}

function attribute(node: MdxNode, name: string) {
  return node.attributes?.find(
    (candidate) => candidate.type === 'mdxJsxAttribute' && candidate.name === name,
  )
}

function matchesAttributes(node: MdxNode, expected: Record<string, string | boolean> | undefined) {
  for (const [name, expectedValue] of Object.entries(expected ?? {})) {
    const candidate = attribute(node, name)
    if (expectedValue === false) {
      if (candidate) return false
      continue
    }
    if (!candidate) return false
    if (expectedValue === true) continue
    if (candidate.value !== expectedValue) return false
  }
  return true
}

function matchesSelector(node: MdxNode, selector: GlyphfluxMdxSelector) {
  if (selector.kind === 'heading') {
    return node.type === 'heading' && (selector.depth === undefined || node.depth === selector.depth)
  }
  return (
    (node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') &&
    node.name === selector.name &&
    matchesAttributes(node, selector.attributes)
  )
}

function plainText(node: MdxNode, sourcePath: string): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') {
    return node.value ?? ''
  }
  if (node.type === 'mdxTextExpression' || node.type === 'mdxFlowExpression') {
    throw new Error(`${sourcePath}: a Glyphflux endpoint cannot contain a dynamic MDX expression`)
  }
  return (node.children ?? []).map((child) => plainText(child, sourcePath)).join('')
}

function selectorText(node: MdxNode, selector: GlyphfluxMdxSelector, sourcePath: string) {
  if (!selector.textAttribute) return plainText(node, sourcePath).trim()
  const value = attribute(node, selector.textAttribute)?.value
  if (typeof value !== 'string') {
    throw new Error(
      `${sourcePath}: ${selector.name ?? selector.kind} requires a static ${selector.textAttribute} attribute`,
    )
  }
  return value.trim()
}

function collect(
  node: MdxNode,
  selectors: readonly GlyphfluxMdxSelector[],
  output: Set<string>,
  sourcePath: string,
) {
  for (const selector of selectors) {
    if (!matchesSelector(node, selector)) continue
    const text = selectorText(node, selector, sourcePath)
    if (!text) throw new Error(`${sourcePath}: a Glyphflux endpoint resolved to empty text`)
    output.add(text)
  }
  for (const child of node.children ?? []) collect(child, selectors, output, sourcePath)
}

async function documentFiles(root: string, document: GlyphfluxDocumentConfig) {
  return (
    await fg(document.include, {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      unique: true,
      ignore: document.exclude ?? [],
    })
  ).sort(compareText)
}

export async function discoverGlyphfluxText({
  config,
  root,
}: LoadedGlyphfluxConfig): Promise<GlyphfluxDiscoveredText> {
  const processor = createProcessor({ format: 'mdx' })
  const sources = new Set(config.texts ?? [])
  const targets = new Set(config.texts ?? [])
  const files = new Set<string>()

  for (const document of config.documents ?? []) {
    for (const path of await documentFiles(root, document)) {
      const sourcePath = relative(root, path).replaceAll('\\', '/')
      files.add(sourcePath)
      let tree: MdxNode
      try {
        tree = processor.parse(await readFile(path, 'utf8')) as unknown as MdxNode
      } catch (error) {
        throw new Error(`${sourcePath}: unable to parse MDX`, { cause: error })
      }
      collect(tree, document.sources, sources, sourcePath)
      collect(tree, document.targets, targets, sourcePath)
    }
  }

  if (!sources.size) throw new Error('No Glyphflux source text was discovered')
  if (!targets.size) throw new Error('No Glyphflux target text was discovered')
  for (const text of sources) {
    if (!targets.has(text)) {
      throw new Error(`Glyphflux source ${JSON.stringify(text)} has no same-text target`)
    }
  }

  return {
    sources: [...sources].sort(compareText),
    targets: [...targets].sort(compareText),
    files: [...files].sort(compareText),
  }
}
