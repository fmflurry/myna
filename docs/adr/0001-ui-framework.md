# ADR 0001: Angular 20 as the UI Framework

**Status**: Decided (Phase 2)  
**Date**: 2026-08-25  
**Context**: Myna is a local-first Tauri 2 app (Rust core + system webview). We need a framework for the webview UI that fits a recording/summarization workflow with real-time updates, form-heavy input (meeting title, template selection), and reactive data flow.

## Decision

Use **Angular 20** with:
- **Standalone components** — no NgModule boilerplate; import-first semantics.
- **Signals** — reactive state without RxJS subscription chains; opt-in granular reactivity.
- **flurryx** — immutable store/facade pattern for meeting domain; zero-mutation discipline.
- **Clean architecture** — presentation/application/core/infrastructure layering; ports/adapters for Tauri IPC.
- **Facade-only component access** — components invoke facades, never use cases directly; UI stays decoupled from business logic.

## Rationale

1. **Standalone + Signals** — Angular 20's standalone API and signals simplify mental models and enable fine-grained reactivity without complex RxJS operators. Cleaner templates, less boilerplate.

2. **flurryx** — Aligns with Myna's immutable Rust domain model. Facades manage use-case orchestration; the store is the single source of truth. Components remain presentation-focused.

3. **Clean architecture** — Ports (e.g., `MeetingRepositoryPort`, `RecorderPort`) abstract Tauri IPC. Infrastructure adapters handle platform details. Domain logic is framework-agnostic.

4. **Facade pattern** — Decouples UI from use-case complexity. A component button triggers `meetingsFacade.startRecording()`, not a sequence of use-case calls. Orchestration is owned by the facade.

5. **Strict TypeScript** — `noImplicitAny: true`, `noExplicitAny: error` — catches interface mismatches early.

6. **Vitest + jsdom** — Browserless unit testing (faster, no Chrome headless overhead). Fits the Myna dev environment where Chrome is unavailable or unstable.

## Options Considered

### Vanilla TypeScript (no framework)
- **Pros**: Minimal dependencies, direct DOM control, small bundle.
- **Cons**: Manual state management, event delegation boilerplate, no structure for growing complexity.
- **Rejected**: Myna's real-time reactive flow (meeting state, live captions, template selection) demands predictable state management; rolling it manually is error-prone.

### React + TypeScript
- **Pros**: Large ecosystem, familiar JSX, Hooks pattern is simpler than older Angular.
- **Cons**: Fragmentary state libraries (Redux, Zustand, Jotai), less opinionated structure, context chains get messy at scale.
- **Rejected**: Myna's clean-architecture layering is easier to express in Angular's module/service structure than scattered React hooks.

### Svelte
- **Pros**: Reactive by default, small bundle, elegant syntax.
- **Cons**: Smaller ecosystem, less mature tooling, fewer large-app patterns.
- **Rejected**: Myna's clean-architecture + ports/adapters pattern is not idiomatic in Svelte's component-centric model.

## Consequences

### Positive
- Clear separation: presentation (components) ↔ application (facades/use cases) ↔ core (domain models).
- Zero-mutation discipline enforced by flurryx store — predictable state transitions.
- Standalone components avoid NgModule cycles and reduce bundle overhead.
- Signals provide reactive updates without RxJS subscription chains.
- Vitest + jsdom unit tests are fast and reliable; no Chrome hangs or flakiness.

### Negative
- Angular has a steeper learning curve than React/Svelte for new team members unfamiliar with dependency injection.
- Large meta-framework (TypeScript + RxJS + Angular core) means bigger initial bundle compared to vanilla TS (mitigated by tree-shaking and lazy routes).
- Standalone + Signals are relatively new in Angular (v14+); API may shift in major versions (unlikely but possible).

## Implementation Notes

- **Module structure**: Feature modules under `src/app/modules/{feature}/` following clean architecture:
  ```
  meetings/
  ├── presentation/       # Components (.component.ts / .component.html)
  ├── application/        # Facades, use cases
  ├── core/               # Domain models, value objects
  └── infrastructure/     # Tauri IPC adapters
  ```
- **Facades**: One per domain aggregate. Handle use-case orchestration and expose a simple async API to components.
- **Use cases**: Stateless, pure. Depend on ports (abstractions) via constructor injection.
- **Ports**: Abstract classes or interfaces defining I/O boundaries (repository, recording service, etc.). Adapters implement them.
- **Components**: Presentation only. Inject facades (never use cases directly) and trigger actions via `(click)="facade.action()"`.
- **Store**: Immutable flurryx store; each domain feature owns its slice.

## References

- Angular 20 standalone: https://angular.io/guide/standalone-components
- Angular signals: https://angular.io/guide/signals
- Vitest + Angular TestBed: https://vitest.dev
- Clean architecture in Angular: ../stack-proposal.md (section 4 — GUI Framework)
