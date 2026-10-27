---
'glyphflux': patch
---

Preserve glyph ink that extends beyond the text layout box during outline morphs. Size the SVG mask and fill to cover both endpoints, including negative letter spacing and overhanging glyphs, and refresh those bounds when controlled endpoints change. This fixes clipped stroke tips at the end of live and replay morphs.

Ease timed outline progress to zero speed at both endpoints so live animations and replay settle smoothly into native text. Keep manually controlled progress direct and preserve the exact endpoint handoff without cross-fading intermediate glyphs.
