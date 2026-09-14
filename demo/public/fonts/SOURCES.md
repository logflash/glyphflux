# Demo font sources

Glyphflux uses local, glyph-subset TTF fixtures so its demo is deterministic,
network-free at runtime, and able to preserve OpenType shaping. All source fonts
are licensed under the SIL Open Font License 1.1; the license text is in
`OFL-1.1.txt`.

The Noto sources were downloaded from the Google Fonts repository at pinned
commit `809e4d8b8d7e9364a914909bb777679606c178b8`. The checked-in subsets can be
reproduced from `demo/catalog.json` by explicitly running:

```sh
node scripts/prepare-demo-fonts.mjs
```

That maintenance command requires network access and `pyftsubset`. Normal
install, build, demo, and test commands never download fonts.

| Render profile | Source | Target | English style labels |
| --- | --- | --- | --- |
| Latin | IBM Plex Sans 400 | Source Serif 4 600 | Sans serif / Serif |
| Cyrillic and Greek | Noto Sans 400 | Noto Serif 600 | Sans serif / Serif |
| Ethiopic | Noto Sans Ethiopic 400 | Noto Serif Ethiopic 600 | Sans serif / Serif |
| Arabic | Noto Sans Arabic 400 | Noto Naskh Arabic 600 | Sans Arabic / Naskh |
| Persian | Noto Sans Arabic 400 | Noto Naskh Arabic 600 | Sans Arabic / Naskh |
| Urdu | Noto Sans Arabic 400 | Noto Naskh Arabic 600 | Sans Arabic / Naskh |
| Bengali | Noto Sans Bengali 400 | Noto Serif Bengali 600 | Sans serif / Serif |
| Gujarati | Noto Sans Gujarati 400 | Noto Serif Gujarati 600 | Sans serif / Serif |
| Hebrew | Noto Sans Hebrew 400 | Noto Serif Hebrew 600 | Sans serif / Serif |
| Devanagari | Noto Sans Devanagari 400 | Noto Serif Devanagari 600 | Sans serif / Serif |
| Marathi | Noto Sans Devanagari 400 | Noto Serif Devanagari 600 | Sans serif / Serif |
| Armenian | Noto Sans Armenian 400 | Noto Serif Armenian 600 | Sans serif / Serif |
| Georgian | Noto Sans Georgian 400 | Noto Serif Georgian 600 | Sans serif / Serif |
| Kannada | Noto Sans Kannada 400 | Noto Serif Kannada 600 | Sans serif / Serif |
| Malayalam | Noto Sans Malayalam 400 | Noto Serif Malayalam 600 | Sans serif / Serif |
| Myanmar | Noto Sans Myanmar 400 | Noto Serif Myanmar 600 | Sans serif / Serif |
| Gurmukhi | Noto Sans Gurmukhi 400 | Noto Serif Gurmukhi 600 | Sans serif / Serif |
| Tamil | Noto Sans Tamil 400 | Noto Serif Tamil 600 | Sans serif / Serif |
| Telugu | Noto Sans Telugu 400 | Noto Serif Telugu 600 | Sans serif / Serif |
| Thai | Noto Sans Thai 400 | Noto Serif Thai 600 | Sans serif / Serif |
| Simplified Chinese | Noto Sans SC 400 | Noto Serif SC 600 | Gothic / Song |
| Traditional Chinese | Noto Sans TC 400 | Noto Serif TC 600 | Gothic / Song |
| Japanese | Noto Sans JP 400 | Noto Serif JP 600 | Gothic / Mincho |
| Korean | Noto Sans KR 400 | Noto Serif KR 600 | Gothic / Myeongjo |

The CJK fixtures are region-specific so localized Han forms never silently fall
back to glyph designs intended for another locale. IBM Plex Sans and Source
Serif 4 are also SIL OFL 1.1 fonts and retain the existing Latin demo baseline.
