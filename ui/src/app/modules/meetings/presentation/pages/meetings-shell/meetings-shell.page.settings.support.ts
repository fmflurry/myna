import type { DestroyRef, Signal, WritableSignal } from '@angular/core';
import { computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { FileDialogPort } from '../../../core/ports/file-dialog.port';

/** Settings-modal visibility + close affordances + native-menu open, grouped so `MeetingsShellPage` stays under the 400-line `max-lines` cap. */
export interface SettingsControls {
  readonly showSettings: Signal<boolean>;
  readonly toggleSettings: () => void;
  /** Closes the modal — the shell's `toggleAbout` calls it so About/Settings exclusion is bidirectional. */
  readonly closeSettings: () => void;
  readonly onBackdropActivate: (event: MouseEvent) => void;
  readonly onBackdropKeydown: (event: KeyboardEvent) => void;
  /** Persisted general guidelines (`facade.summaryGuidelines()`); seeds the Settings textarea. */
  readonly guidelines: Signal<string>;
  /** Settings save-on-blur / Save click; the store slot updates only once the facade write succeeds. */
  readonly onGuidelinesChanged: (text: string) => void;
  /** Effective meetings data root; `undefined` until `loadStorageLocation` resolves. */
  readonly storagePath: Signal<string | undefined>;
  /** True while recording/importing/summarizing or a storage move is in flight — disables Change/Reset. */
  readonly storageBusy: Signal<boolean>;
  /** Inline storage failure (PATH/BUSY validation or move failure); `null` hides it. */
  readonly storageError: Signal<string | null>;
  /** True right after a move that needs an app restart. */
  readonly storageRestartRequired: Signal<boolean>;
  /** Pending Move vs Stay choice (default Move); mirrored from the Settings checkbox via `onMoveExistingChanged`. */
  readonly moveExisting: Signal<boolean>;
  /** Settings Move checkbox toggled — records the pending choice; no facade call until Change…/Reset. */
  readonly onMoveExistingChanged: (moveExisting: boolean) => void;
  /** Change… — opens `FileDialogPort.selectDirectory`, then `facade.setStorageLocation(dir, choice)`; a dialog cancel returns `null` and issues no facade call (clears working, no error). */
  readonly onBrowseStorage: (moveExisting?: boolean) => void;
  /** Reset to default — calls `facade.resetStorageLocation(choice)` with the pending choice. */
  readonly onResetStorage: (moveExisting?: boolean) => void;
}

/**
 * Builds the settings-modal controls. Every open path (gear toggle, native
 * "Settings…" menu request) closes About, and the shell's `toggleAbout`
 * closes Settings via {@link SettingsControls.closeSettings} — the two
 * modals are mutually exclusive in both directions. The error callback keeps
 * a missing Tauri event bridge (headless specs; a release where `listen()`
 * cannot register) from crashing boot — the gear button opens Settings
 * regardless. Opening the modal refreshes `loadStorageLocation` so the
 * storage section never shows a stale path; a rejected move keeps the
 * previous location on screen for retry.
 */
export function createSettingsControls(
  facade: MeetingsFacade,
  showAbout: WritableSignal<boolean>,
  destroyRef: DestroyRef,
): SettingsControls {
  const showSettings = signal(false);
  // Optional: shell specs that stub the facade with member subsets predate
  // storage wiring and provide no `FileDialogPort` — a missing dialog
  // degrades Change… to a no-op, never throws (mirrors the `stopPhase`
  // `Partial` view in `meetings-shell.page.ts`).
  const fileDialog = inject(FileDialogPort, { optional: true });
  const storageSignals = facade as Partial<
    Pick<MeetingsFacade, 'storageLocation' | 'loadStorageLocation' | 'setStorageLocation' | 'resetStorageLocation'>
  >;
  const storageWorking = signal(false);
  const moveExistingChoice = signal(true);
  const storagePath = computed(() => storageSignals.storageLocation?.()?.path);
  const storageRestartRequired = computed(() => storageSignals.storageLocation?.()?.restartRequired ?? false);
  const storageBusy = computed(() => facade.busy() || facade.importing() || facade.summarizing() || storageWorking());
  const storageError = computed(() => {
    const error = facade.error();
    if (error === undefined) {
      return null;
    }
    if (error.source !== 'setStorageLocation' && error.source !== 'resetStorageLocation' && error.source !== 'loadStorageLocation') {
      return null;
    }
    return error.message;
  });
  const openSettings = (): void => {
    showAbout.set(false);
    showSettings.set(true);
    void storageSignals.loadStorageLocation?.();
  };
  const closeSettings = (): void => showSettings.set(false);
  const toggleSettings = (): void => (showSettings() ? closeSettings() : openSettings());
  facade
    .settingsRequests()
    .pipe(takeUntilDestroyed(destroyRef))
    .subscribe({ next: () => openSettings(), error: () => undefined });
  return {
    showSettings: showSettings.asReadonly(),
    toggleSettings,
    closeSettings,
    onBackdropActivate: (event) => {
      if (event.target === event.currentTarget) {
        closeSettings();
      }
    },
    onBackdropKeydown: (event) => {
      // Escape is modal-wide; Enter/Space only when the backdrop itself is
      // the target — a bubbled Space from the consent checkbox must toggle
      // the checkbox, not close the modal.
      if (event.key === 'Escape' || (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' '))) {
        event.preventDefault();
        closeSettings();
      }
    },
    guidelines: facade.summaryGuidelines,
    onGuidelinesChanged: (text) => {
      void facade.setSummaryGuidelines(text);
    },
    storagePath,
    storageBusy,
    storageError,
    storageRestartRequired,
    moveExisting: moveExistingChoice.asReadonly(),
    onMoveExistingChanged: (choice) => {
      moveExistingChoice.set(choice);
    },
    onBrowseStorage: (choice) => {
      if (fileDialog === null || facade.busy() || facade.importing() || facade.summarizing() || storageWorking()) {
        return;
      }
      const moveExistingFlag = choice ?? moveExistingChoice();
      storageWorking.set(true);
      void (async () => {
        try {
          const directory = await fileDialog.selectDirectory();
          if (directory === null) {
            return;
          }
          await storageSignals.setStorageLocation?.(directory, moveExistingFlag);
        } finally {
          storageWorking.set(false);
        }
      })();
    },
    onResetStorage: (choice) => {
      if (facade.busy() || facade.importing() || facade.summarizing() || storageWorking()) {
        return;
      }
      const moveExistingFlag = choice ?? moveExistingChoice();
      storageWorking.set(true);
      void (async () => {
        try {
          await storageSignals.resetStorageLocation?.(moveExistingFlag);
        } finally {
          storageWorking.set(false);
        }
      })();
    },
  };
}
