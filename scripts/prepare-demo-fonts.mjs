import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { fontSubsetCoverage } from './font-subset-coverage.mjs'

const googleFontsCommit = '809e4d8b8d7e9364a914909bb777679606c178b8'
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const catalog = JSON.parse(await readFile(resolve(packageRoot, 'demo/catalog.json'), 'utf8'))
const regressionFixtures = JSON.parse(
  await readFile(resolve(packageRoot, 'demo/regression-fixtures.json'), 'utf8'),
)
const fontDirectory = resolve(packageRoot, 'demo/public/fonts')
const rawRoot = `https://raw.githubusercontent.com/google/fonts/${googleFontsCommit}/ofl`

const sources = {
  'ibm-plex-sans-extended-400-outline.ttf': [
    'ibmplexsans',
    'IBMPlexSans%5Bwdth%2Cwght%5D.ttf',
  ],
  'source-serif-4-extended-600-outline.ttf': [
    'sourceserif4',
    'SourceSerif4%5Bopsz%2Cwght%5D.ttf',
  ],
  'noto-sans-400-outline.ttf': ['notosans', 'NotoSans%5Bwdth%2Cwght%5D.ttf'],
  'noto-serif-600-outline.ttf': ['notoserif', 'NotoSerif%5Bwdth%2Cwght%5D.ttf'],
  'noto-sans-ethiopic-400-outline.ttf': [
    'notosansethiopic',
    'NotoSansEthiopic%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-ethiopic-600-outline.ttf': [
    'notoserifethiopic',
    'NotoSerifEthiopic%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-sans-arabic-400-outline.ttf': [
    'notosansarabic',
    'NotoSansArabic%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-naskh-arabic-600-outline.ttf': [
    'notonaskharabic',
    'NotoNaskhArabic%5Bwght%5D.ttf',
  ],
  'noto-sans-bengali-400-outline.ttf': [
    'notosansbengali',
    'NotoSansBengali%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-bengali-600-outline.ttf': [
    'notoserifbengali',
    'NotoSerifBengali%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-sans-gujarati-400-outline.ttf': [
    'notosansgujarati',
    'NotoSansGujarati%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-gujarati-600-outline.ttf': [
    'notoserifgujarati',
    'NotoSerifGujarati%5Bwght%5D.ttf',
  ],
  'noto-sans-hebrew-400-outline.ttf': [
    'notosanshebrew',
    'NotoSansHebrew%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-hebrew-600-outline.ttf': [
    'notoserifhebrew',
    'NotoSerifHebrew%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-sans-armenian-400-outline.ttf': [
    'notosansarmenian',
    'NotoSansArmenian%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-armenian-600-outline.ttf': [
    'notoserifarmenian',
    'NotoSerifArmenian%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-sans-georgian-400-outline.ttf': [
    'notosansgeorgian',
    'NotoSansGeorgian%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-georgian-600-outline.ttf': [
    'notoserifgeorgian',
    'NotoSerifGeorgian%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-sans-kannada-400-outline.ttf': [
    'notosanskannada',
    'NotoSansKannada%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-kannada-600-outline.ttf': [
    'notoserifkannada',
    'NotoSerifKannada%5Bwght%5D.ttf',
  ],
  'noto-sans-malayalam-400-outline.ttf': [
    'notosansmalayalam',
    'NotoSansMalayalam%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-malayalam-600-outline.ttf': [
    'notoserifmalayalam',
    'NotoSerifMalayalam%5Bwght%5D.ttf',
  ],
  'noto-sans-myanmar-400-outline.ttf': [
    'notosansmyanmar',
    'NotoSansMyanmar%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-myanmar-600-outline.ttf': [
    'notoserifmyanmar',
    'NotoSerifMyanmar-SemiBold.ttf',
  ],
  'noto-sans-gurmukhi-400-outline.ttf': [
    'notosansgurmukhi',
    'NotoSansGurmukhi%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-gurmukhi-600-outline.ttf': [
    'notoserifgurmukhi',
    'NotoSerifGurmukhi%5Bwght%5D.ttf',
  ],
  'noto-sans-tamil-400-outline.ttf': [
    'notosanstamil',
    'NotoSansTamil%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-tamil-600-outline.ttf': [
    'notoseriftamil',
    'NotoSerifTamil%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-sans-telugu-400-outline.ttf': [
    'notosanstelugu',
    'NotoSansTelugu%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-telugu-600-outline.ttf': [
    'notoseriftelugu',
    'NotoSerifTelugu%5Bwght%5D.ttf',
  ],
  'noto-sans-thai-400-outline.ttf': [
    'notosansthai',
    'NotoSansThai%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-thai-600-outline.ttf': [
    'notoserifthai',
    'NotoSerifThai%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-naskh-urdu-600-outline.ttf': [
    'notonaskharabic',
    'NotoNaskhArabic%5Bwght%5D.ttf',
  ],
  'noto-sans-persian-400-outline.ttf': [
    'notosansarabic',
    'NotoSansArabic%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-naskh-persian-600-outline.ttf': [
    'notonaskharabic',
    'NotoNaskhArabic%5Bwght%5D.ttf',
  ],
  'noto-sans-urdu-400-outline.ttf': [
    'notosansarabic',
    'NotoSansArabic%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-sans-marathi-400-outline.ttf': [
    'notosansdevanagari',
    'NotoSansDevanagari%5Bwdth%2Cwght%5D.ttf',
  ],
  'noto-serif-marathi-600-outline.ttf': [
    'notoserifdevanagari',
    'NotoSerifDevanagari%5Bwdth%2Cwght%5D.ttf',
  ],
}

const requiredByFile = new Map()
for (const language of [...catalog.languages, ...regressionFixtures]) {
  const profile = catalog.profiles[language.profile]
  for (const file of [profile.sourceFile, profile.targetFile]) {
    if (!sources[file]) continue
    requiredByFile.set(file, `${requiredByFile.get(file) ?? ''}${language.text}`)
  }
}

const run = (command, arguments_) =>
  new Promise((resolveRun, reject) => {
    const child = spawn(command, arguments_, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) =>
      code === 0 ? resolveRun() : reject(new Error(`${command} exited with ${code}`)),
    )
  })

const temporaryDirectory = await mkdtemp(resolve(tmpdir(), 'glyphflux-fonts-'))
try {
  for (const [outputFile, text] of [...requiredByFile].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const [family, sourceFile] = sources[outputFile]
    const url = `${rawRoot}/${family}/${sourceFile}`
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Unable to download ${url}: ${response.status}`)
    const sourcePath = resolve(temporaryDirectory, basename(outputFile))
    const textPath = resolve(temporaryDirectory, `${basename(outputFile)}.txt`)
    await writeFile(sourcePath, new Uint8Array(await response.arrayBuffer()))
    await writeFile(textPath, fontSubsetCoverage(text), 'utf8')
    await run('pyftsubset', [
      sourcePath,
      `--output-file=${resolve(fontDirectory, outputFile)}`,
      `--text-file=${textPath}`,
      '--layout-features=*',
      '--glyph-names',
      '--symbol-cmap',
      '--legacy-cmap',
      '--notdef-glyph',
      '--notdef-outline',
      '--recommended-glyphs',
      '--name-IDs=*',
      '--name-legacy',
      '--name-languages=*',
      '--no-recalc-timestamp',
    ])
    const output = await readFile(resolve(fontDirectory, outputFile))
    console.log(`${outputFile}\t${output.length}\t${createHash('sha256').update(output).digest('hex')}`)
  }
} finally {
  await rm(temporaryDirectory, { force: true, recursive: true })
}
