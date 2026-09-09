# ui

Angular 20 standalone application — the webview frontend for Myna, wired for
Tauri. Strict TypeScript, ESLint (angular-eslint + typescript-eslint), and
flurryx state tooling are installed. The single feature module lives at
`src/app/modules/meetings/` (Clean Architecture layers: `presentation/`,
`application/`, `core/`, `infrastructure/`), lazy-loaded via
`meetings.routes.ts` and self-registered through `provideMeetings()`. Only
`infrastructure/tauri/ipc.ts` and
`infrastructure/tauri/tauri-file-dialog.adapter.ts` may import Tauri
packages.

Build output lands at `dist/index.html` (see `angular.json` `outputPath`),
which is what the Tauri shell's `frontendDist` config points at.

## Verification

```bash
npm install
npm run lint
npx tsc -p tsconfig.json --noEmit
npm run build
npm test -- --watch=false
```
