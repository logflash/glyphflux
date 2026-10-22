# glyphflux

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
