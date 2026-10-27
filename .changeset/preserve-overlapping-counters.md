---
'glyphflux': patch
---

Preserve counters when outline morphs pair self-overlapping font contours with explicit holes, such as Source Serif 4 and IBM Plex Sans digits. Normalize affected glyph silhouettes using the nonzero fill rule before matching boundaries, while retaining original curves for unaffected glyphs. The same prepared outlines are used by live animations and replay.
