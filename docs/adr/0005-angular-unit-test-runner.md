# ADR 0005: Vitest + jsdom as the Angular Unit Test Runner

**Status**: Decided (Phase 2)  
**Date**: 2026-08-25  
**Context**: Myna's Angular 20 UI requires a unit-test runner. Historically, Angular prescribed Karma + Chrome; Angular 17+ introduced an experimental `@angular/build:unit-test` builder with pluggable runners (Karma, Vitest, Web Test Runner). Myna targets macOS-first with constrained testing environments (no usable Chrome).

## Decision

Use **`@angular/build:unit-test`** with **`vitest`** runner and **`jsdom`** environment:
- **Builder**: `@angular/build:unit-test` (experimental, Angular 17+; tested on Angular 20).
- **Test runner**: Vitest (fast, parallel, Jest-compatible syntax).
- **Environment**: jsdom (browser API simulation; no Chrome instance required).
- **Configuration**: `angular.json` targets builder `@angular/build:unit-test` with runner `vitest` and environment `jsdom`.
- **CLI**: `npm test` (or `ng test`) runs specs; `npm test -- --watch=false` runs once (CI-friendly).

## Rationale

1. **No Chrome available in target environment**: Myna's primary macOS development environment lacks a usable Chrome instance. `/opt/homebrew/bin/chromium` either crashes with SIGTRAP or is missing; Playwright's "Chrome for Testing" hangs on the Tauri webview sandbox. Karma + Chrome is not viable.

2. **Vitest is fast**: Parallel test execution, hot-reload on file change, tree-shaking of test dependencies. Typical suite runs in <2s.

3. **jsdom is sufficient for UI tests**: For Angular components with reactive forms, directives, and services, jsdom provides enough DOM API surface. Full browser environment (Puppeteer, Playwright) is overkill for unit tests.

4. **Zero spec rewrites**: Angular's TestBed API is unchanged. Existing specs using `describe`, `it`, `expect`, TestBed fixtures, and asyncData/fakeAsync continue to work without modification.

5. **Angular 20 officially supports it**: The builder and Vitest runner are community-vetted; Angular docs cite them as the modern alternative to Karma.

## Options Considered

### Karma + Chrome
- **Pros**: Historically the Angular default, mature, headless Chrome support.
- **Cons**: Requires Chrome/Chromium; not available in Myna's target environment. Slow (single-threaded test execution by default).
- **Rejected**: Chrome is unavailable; Karma + Chrome is not an option.

### Playwright with @playwright/test
- **Pros**: Full browser control, real rendering.
- **Cons**: Heavier, slower (1 browser per suite), requires Playwright binary (falls back to unsupported system Chrome). Overkill for unit tests.
- **Rejected**: Unit tests don't need full browser simulation. Playwright is better suited for E2E tests.

### Web Test Runner (WTR)
- **Pros**: Browser-agnostic, Node-like test environment.
- **Cons**: Less mature than Vitest, smaller ecosystem, slower test feedback.
- **Rejected**: Vitest is faster, more widely adopted, and has better IDE integration.

### Jest + jsdom
- **Pros**: Also browser-agnostic, widely used.
- **Cons**: Jest's transform pipeline is heavier; Vitest is faster and has better ES module support. Jest is designed for monorepos; Vitest scales better for single projects.
- **Rejected**: Vitest is the next-generation Jest; benefits justify the switch.

## Consequences

### Positive
- **No Chrome dependency**: Tests run in Node.js with simulated DOM. No browser process to manage or debug.
- **Fast feedback loop**: Parallel execution, hot-reload on file changes. Developers see results in <2s.
- **Standard Angular TestBed API**: Specs don't change. Existing tests migrate without rewrite.
- **ES module support**: Vitest handles modern JS natively; no transpilation overhead.
- **IDE integration**: Vitest plugins for VS Code, WebStorm detect and run tests inline.

### Negative
- **Builder is experimental**: Angular team labels `@angular/build:unit-test` as EXPERIMENTAL (not stable API). A future Angular major release may change builder internals. Mitigation: stay on Angular 20 LTS; if migration is needed, fallback is bare `vitest run --config vitest.config.ts` with `environment: 'jsdom'` (specs need no changes).
- **jsdom is incomplete**: Not all DOM APIs are simulated. Specs using canvas rendering, WebGL, or audio playback will fail. Mitigation: mock those APIs; Myna's UI does not use them.

## Implementation Notes

- **angular.json** configuration:
  ```json
  {
    "projects": {
      "myna-ui": {
        "architect": {
          "test": {
            "builder": "@angular/build:unit-test",
            "options": {
              "polyfills": ["zone.js", "zone.js/testing"],
              "environment": "jsdom",
              "runner": "vitest"
            }
          }
        }
      }
    }
  }
  ```
- **package.json** scripts:
  ```json
  {
    "scripts": {
      "test": "ng test",
      "test:ci": "ng test -- --watch=false --reporters=verbose"
    }
  }
  ```
- **vitest.config.ts** (optional; for advanced settings):
  ```typescript
  export default {
    test: {
      environment: 'jsdom',
      globals: true,
      include: ['src/**/*.spec.ts']
    }
  };
  ```
- **Fallback**: If `@angular/build:unit-test` breaks in a future Angular version, run tests directly via Vitest:
  ```bash
  npx vitest run --config vitest.config.ts
  ```
  Specs need no changes; the test framework API remains the same.

## Migration from Karma (if applicable)

If tests were previously under Karma:
1. Remove `karma.conf.js` and Karma dependencies from `package.json`.
2. Update `angular.json` to use `@angular/build:unit-test` with `vitest` runner.
3. Install: `npm install --save-dev @vitest/ui`.
4. Run: `npm test`. All specs work as-is (TestBed syntax unchanged).

## References

- Angular 20 testing: https://angular.io/guide/testing
- `@angular/build:unit-test` builder: https://angular.io/cli/test
- Vitest documentation: https://vitest.dev/
- jsdom documentation: https://github.com/jsdom/jsdom
