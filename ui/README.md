# ui

Angular 20 standalone application — the webview frontend for Myna, wired for Tauri.
Strict TypeScript, ESLint (angular-eslint + typescript-eslint), and flurryx state
tooling are installed. This is currently a router shell only; feature modules are
added in later phases under `src/app/modules/`.

Build output lands at `dist/index.html` (see `angular.json` `outputPath`), which is
what the Tauri shell's `frontendDist` config points at.

## Verification

```bash
npm install
npm run lint
npx tsc -p tsconfig.json --noEmit
npm run build
npm test -- --watch=false
```
