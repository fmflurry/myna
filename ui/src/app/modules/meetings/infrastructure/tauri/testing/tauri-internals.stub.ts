import { vi } from 'vitest';

/**
 * Installs a minimal `window.__TAURI_INTERNALS__` stub so specs can drive
 * the real Tauri JS client package — and therefore the real `ipc.ts` —
 * without a live Tauri runtime.
 *
 * This project's `@angular/build:unit-test` + vitest integration is
 * EXPERIMENTAL and does not honor `vi.mock()` module interception for
 * either relative (`./ipc`) or bare (Tauri client package) specifiers:
 * mocked exports come back as plain, un-spied functions at runtime
 * (confirmed empirically — `vi.mocked(fn).mockResolvedValueOnce` throws
 * `is not a function`). `invoke()` and `listen()` both bottom out in
 * `window.__TAURI_INTERNALS__` (see the Tauri client's `core.js` and
 * `event.js`), so stubbing that global gives full, deterministic control
 * over both without needing module interception at all.
 */
export interface TauriInternalsStub {
  /** Simulates the Rust core pushing `payload` on `event`. */
  emit(event: string, payload: unknown): void;
  /** Spy over every command name the stub received, for assertions. */
  readonly invokeSpy: ReturnType<typeof vi.fn>;
}

interface ListenArgs {
  readonly event: string;
  readonly handler: number;
}

type CommandHandler = (cmd: string, args: unknown) => unknown;

/**
 * Installs the stub, routing every command other than the internal
 * `plugin:event|listen` / `plugin:event|unlisten` bookkeeping to
 * `handleCommand`. Throwing inside `handleCommand` rejects the
 * corresponding `invoke()` call, mirroring a Rust `Err(AppError)`.
 */
export function installTauriInternalsStub(handleCommand: CommandHandler): TauriInternalsStub {
  const callbacksById = new Map<number, (payload: unknown) => void>();
  const eventToCallbackId = new Map<string, number>();
  let nextId = 1;

  const invokeSpy = vi.fn(async (cmd: string, args?: unknown) => {
    if (cmd === 'plugin:event|listen') {
      const { event, handler } = args as ListenArgs;
      eventToCallbackId.set(event, handler);
      return nextId++;
    }
    if (cmd === 'plugin:event|unlisten') {
      return null;
    }
    return handleCommand(cmd, args);
  });

  const transformCallback = (callback: (payload: unknown) => void): number => {
    const id = nextId++;
    callbacksById.set(id, callback);
    return id;
  };

  (globalThis as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: invokeSpy,
    transformCallback,
  };

  // `_unlisten()` in the Tauri client's `event.js` calls this global directly
  // — NOT through `invoke()` — before it also invokes `plugin:event|unlisten`.
  (globalThis as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ =
    { unregisterListener: (): void => undefined };

  return {
    invokeSpy,
    emit(event, payload) {
      const callbackId = eventToCallbackId.get(event);
      const callback = callbackId !== undefined ? callbacksById.get(callbackId) : undefined;
      if (!callback) {
        throw new Error(`No listener registered for event '${event}'`);
      }
      callback({ payload });
    },
  };
}

/** Removes the stub installed by {@link installTauriInternalsStub}. */
export function uninstallTauriInternalsStub(): void {
  delete (globalThis as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  delete (globalThis as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__?: unknown })
    .__TAURI_EVENT_PLUGIN_INTERNALS__;
}

/**
 * Awaits a macrotask so every pending microtask (the `invoke().then(...)`
 * chains inside `listen()`/`onEvent()`) has drained. A fixed number of
 * `await Promise.resolve()` hops is brittle here because `listen()` chains
 * several `.then()`s before `onEvent()`'s own subscriber logic runs.
 */
export async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
