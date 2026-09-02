/**
 * Shared spec helper: pins `window.innerWidth` so a component's
 * narrow/wide layout branch is deterministic under jsdom (whose default
 * is 1024). Import-only — the window object is touched at call time,
 * never at module load.
 */
export const setViewportWidth = (width: number): void => {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
};
