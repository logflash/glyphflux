# Demo terminology

The sample is the typographic term **allograph**, not the language name. The
catalog keeps those two fields separate so a locale label can never become the
text being morphed.

`terminology.json` records one of two source categories for every demo entry:

- `established-local-term` uses a conventional native technical term or
  technical paraphrase, including the established CJK terms for variant glyphs.
- `localized-internationalism` uses the language's conventional spelling or
  script transliteration of the international technical term *allograph* where
  no more authoritative native equivalent was established for this demo.

The distinction is deliberately conservative: a localized internationalism is
not presented as an official standard. Terms were checked as typography or
linguistics terminology, preserved in their normal script and direction, and
then verified against both selected local fonts. The build rejects empty text,
locale-name placeholders, missing glyphs, mismatched shaping direction, and
unclassified entries.

Canonical-equivalent code points are included when fonts are subset. This is
required because an OpenType shaper may decompose a precomposed character even
when the authored string retains that character, as happens with Bengali vowel
signs.
