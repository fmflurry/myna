# Myna visual identity

## Primary direction
Minimal myna bird + open beak + audio waveform.

## Typography

### Brand / headings: Poppins
Recommended weights:
- 600 Semibold: logo, H1-H3, important labels
- 500 Medium: buttons and navigation
- 400 Regular: occasional short display copy

The `myna` wordmark is lowercase Poppins Semibold with tighter tracking (`letter-spacing: -0.045em`).

### Product UI / body: Inter
Recommended weights:
- 400 Regular: body text
- 500 Medium: controls, table headings, metadata
- 600 Semibold: stronger UI emphasis

This pairing keeps the brand friendly and rounded while preserving excellent readability in dense meeting/transcription interfaces.

## Colors
- Ink: `#0F1115`
- Myna Yellow: `#FFC300`
- Off White: `#F7F7F5`
- Optional AI/Product Accent: `#6366F1`

Yellow is an accent, not a large background color. Prefer Ink + Off White as the UI foundation.

## Files
- `myna-logo-horizontal.svg`: primary logo for light backgrounds
- `myna-logo-horizontal-dark.svg`: version for dark backgrounds
- `myna-symbol.svg`: bird + audio waveform, no wordmark
- `myna-mark.svg`: compact bird-only mark
- `myna-app-icon.svg`: square app/PWA icon source
- `myna-monochrome.svg`: single-color mask / print / CSS `currentColor`
- `brand-tokens.css`: starter design tokens and typography

## Web font import
Google Fonts example:

```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Poppins:wght@400;500;600&display=swap');
```

For production, self-hosting the WOFF2 files is preferable for privacy, caching and performance.

## Logo usage
- Keep clear space around the logo roughly equal to the height of the lowercase `m` stem.
- Do not recolor the yellow eye/beak/waveform independently.
- Do not add shadows or gradients to the core logo.
- Below ~28 px, prefer `myna-mark.svg` instead of the full audio symbol.
