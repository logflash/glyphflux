# glyphflux

## 0.1.6

### Patch Changes

- 587b23c: Preserve counters when outline morphs pair self-overlapping font contours with explicit holes, such as Source Serif 4 and IBM Plex Sans digits. Normalize affected glyph silhouettes using the nonzero fill rule before matching boundaries, while retaining original curves for unaffected glyphs. The same prepared outlines are used by live animations and replay.

## 0.1.5

### Patch Changes

- b387dbd: Update the demo's TanStack Start dependency and standalone lockfile to resolve CVE-2026-102989, including the patched server core. This fixes Vercel's security deployment block and ensures local and self-hosted demo builds use the patched dependencies.

## 0.1.4

### Patch Changes

- 43bffa6: Derive morph weights from endpoint font styles, preventing mismatches between generated glyphs and native text. Remove the extra transformed-text frame at completion to prevent a visible weight flash. Verify direct handoff to native text across desktop and mobile demo transitions.

## 0.1.3

### Patch Changes

- 78f8580: Group the Glyphflux logo, wordmark, and GitHub icon into one repository link with a shared hover state throughout the demo site.

## 0.1.2

### Patch Changes

- 877f32e: Add Glyphflux branding and polish the demo site with full-page view states, stable controls, an updated showcase animation, and deterministic GIF color encoding.

## 0.1.1

### Patch Changes

- 5cede7b: Calibrate SDF endpoint alignment against native browser font rasterization at the active device-pixel ratio, preventing visible vertical jumps when controlled morphs, view transitions, and replay hand off to settled text.
