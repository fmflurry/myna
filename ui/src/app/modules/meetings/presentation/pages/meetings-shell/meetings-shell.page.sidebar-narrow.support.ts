import type { DestroyRef, Signal } from '@angular/core';
import { effect, signal } from '@angular/core';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';

/**
 * Shell viewport width below which the sidebar auto-collapses to its rail
 * (see {@link createSidebarNarrowControls}). Deliberately BELOW the detail
 * pane's `NARROW_BREAKPOINT_PX` (1200): between 900 and 1200 the detail pane
 * already runs its narrow single-column tabbed fallback while the sidebar
 * stays usable beside it — only under ~900 must the sidebar itself yield.
 * The shell CSS pins `overflow-x` so neither breakpoint can ever produce
 * horizontal scroll.
 */
export const SIDEBAR_NARROW_BREAKPOINT_PX = 900;

/** True when the shell viewport is too narrow for the expanded sidebar. */
export const isSidebarNarrowViewport = (width: number): boolean => width < SIDEBAR_NARROW_BREAKPOINT_PX;

/**
 * Escape collapses the sidebar, but ONLY in the narrow fallback where the
 * sidebar behaves like a dismissible layer — on wide windows Esc keeps
 * belonging to modals and menus. Returns `true` when it handled the event.
 * Never steals Esc from an open modal (a `.modal` ancestor), and a no-op
 * unless the sidebar is actually expanded.
 */
export function closeSidebarOnEscape(facade: MeetingsFacade, event: KeyboardEvent): boolean {
  if (typeof window === 'undefined' || !isSidebarNarrowViewport(window.innerWidth)) {
    return false;
  }
  if (facade.sidebarCollapsed()) {
    return false;
  }
  const target = event.target as HTMLElement | null;
  if (target instanceof HTMLElement && target.closest('.modal') !== null) {
    return false;
  }
  event.preventDefault();
  facade.setSidebarCollapsed(true);
  return true;
}

/**
 * Collapse/expand focus move + return, shared by every sidebar toggle path
 * (rail button, Cmd/Ctrl+B, narrow auto-collapse, Escape). Collapsing
 * unmounts the sidebar pane out from under keyboard focus, so focus moves to
 * the rail toggle; expanding returns it there as the stable landmark — the
 * toggle persists in both states. Only moves when focus is inside the
 * splitter or on `body`, so it never yanks focus out of the detail pane.
 */
export function moveFocusToSidebarToggle(): void {
  if (typeof document === 'undefined') {
    return;
  }
  const toggle = document.querySelector('app-sidebar-splitter .collapse-toggle');
  if (!(toggle instanceof HTMLElement)) {
    return;
  }
  const active = document.activeElement;
  const insideSplitter = active instanceof HTMLElement && active.closest('app-sidebar-splitter') !== null;
  if (insideSplitter || active === null || active === document.body) {
    toggle.focus();
  }
}

/**
 * Narrow-window sidebar fallback + collapse/expand focus management, grouped
 * so `MeetingsShellPage` stays under the 400-line `max-lines` cap. Owns a
 * `resize` listener (released on destroy) and two effects: entering the
 * narrow viewport auto-collapses an expanded sidebar to its rail exactly
 * once per crossing — a manual re-expand while narrow sticks until the
 * window leaves and re-enters narrow — and every collapse/expand moves
 * keyboard focus via {@link moveFocusToSidebarToggle}.
 */
export interface SidebarNarrowControls {
  /** Live shell viewport width — drives the auto-collapse effect only; the template never reads it. */
  readonly viewportWidth: Signal<number>;
}

/** Builds {@link SidebarNarrowControls} bound to `facade`. Effects run in the caller's injection context (field initializer). */
export function createSidebarNarrowControls(facade: MeetingsFacade, destroyRef: DestroyRef): SidebarNarrowControls {
  const viewportWidth = signal(typeof window === 'undefined' ? SIDEBAR_NARROW_BREAKPOINT_PX : window.innerWidth);
  if (typeof window !== 'undefined') {
    const onResize = (): void => viewportWidth.set(window.innerWidth);
    window.addEventListener('resize', onResize);
    destroyRef.onDestroy(() => window.removeEventListener('resize', onResize));
  }
  let wasNarrow = false;
  effect(() => {
    const narrow = isSidebarNarrowViewport(viewportWidth());
    const enteredNarrow = narrow && !wasNarrow;
    wasNarrow = narrow;
    if (enteredNarrow && !facade.sidebarCollapsed()) {
      facade.setSidebarCollapsed(true);
    }
  });
  let previousCollapsed: boolean | undefined;
  effect(() => {
    const collapsed = facade.sidebarCollapsed();
    if (previousCollapsed === undefined) {
      previousCollapsed = collapsed;
      return;
    }
    if (collapsed !== previousCollapsed) {
      previousCollapsed = collapsed;
      moveFocusToSidebarToggle();
    }
  });
  return { viewportWidth: viewportWidth.asReadonly() };
}
