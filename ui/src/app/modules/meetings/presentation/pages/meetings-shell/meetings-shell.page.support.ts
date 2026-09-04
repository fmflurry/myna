import type { DestroyRef, Signal, WritableSignal } from '@angular/core';
import { computed, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Router } from '@angular/router';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { describeSpeakerOp, type SpeakerOp } from '../../../application/stores/speaker-history.model';
import { describeTranscriptOp, type TranscriptOp } from '../../../application/stores/transcript-history.model';
import type { SystemAudioStatus } from '../../../core/models/capture-source.model';
import type { FolderId } from '../../../core/models/folder.model';
import type { Meeting, MeetingId } from '../../../core/models/meeting.model';
import type { SummaryInstructionsDraft } from '../../../core/models/summary-instructions.model';
import type { UpdateConsent } from '../../../core/models/update.model';
import type { SummaryDraftChange } from '../../components/meeting-detail-pane/meeting-detail-pane.component';
import type { MeetingDragMoveRequest } from '../../components/meeting-sidebar/meeting-sidebar.component';
import { closeSidebarOnEscape } from './meetings-shell.page.sidebar-narrow.support';
export { createSidebarNarrowControls } from './meetings-shell.page.sidebar-narrow.support';

/**
 * Shown to the capture-source-picker before `checkSystemAudio()` has
 * resolved. `unknown`, not `unavailable` — there is no preflight API for
 * the audio permission, so the system/mixed options must stay selectable
 * even during this brief window, not just once the check settles.
 */
export const CHECKING_SYSTEM_AUDIO: SystemAudioStatus = { kind: 'unknown' };

const ISO_DATE_LENGTH = 10;

/** `"<title> - <YYYY-MM-DD>"` — the suggested file name the export dialog offers. */
export const buildExportFilename = (meeting: Meeting): string =>
  `${meeting.title} - ${meeting.createdAt.toISOString().slice(0, ISO_DATE_LENGTH)}`;

/** The meeting's CURRENT folder (or `null`), looked up from `meetings` — used to preserve filing when archiving. */
function currentFolderId(meetings: readonly Meeting[], id: MeetingId): FolderId | null {
  return meetings.find((meeting) => meeting.id === id)?.folderId ?? null;
}

/**
 * Drag-and-drop is the only way to move or archive a meeting — this is the
 * sole handler for both; it routes by the drop target's `kind`, always via
 * `facade.placeMeeting` with `previousId`/`nextId` both `null` (the backend
 * resolves that to `Placement::Keep` — container change only, matching
 * today's behaviour but as one write instead of two). Archiving preserves
 * the meeting's CURRENT folder — looked up from `meetings` — so a meeting
 * dragged to the archive never loses its filing.
 */
export function runMeetingMoveRequested(facade: MeetingsFacade, meetings: readonly Meeting[], request: MeetingDragMoveRequest): void {
  const { target } = request;
  if (target.kind === 'placement') {
    const { container, previousId, nextId } = target;
    if (container.kind === 'archive') {
      void facade.placeMeeting(request.id, currentFolderId(meetings, request.id), true, previousId, nextId);
      return;
    }
    const folderId = container.kind === 'folder' ? container.folderId : null;
    void facade.placeMeeting(request.id, folderId, false, previousId, nextId);
    return;
  }
  if (target.kind === 'archive') {
    void facade.placeMeeting(request.id, currentFolderId(meetings, request.id), true, null, null);
    return;
  }
  const folderId = target.kind === 'folder' ? target.folderId : null;
  void facade.placeMeeting(request.id, folderId, false, null, null);
}

/**
 * There is no finished recording session on disk to stop first —
 * `cancelRecording()` stops the session and wipes the meeting dir, including
 * audio.wav, instead of `deleteMeeting()`.
 */
export function runMeetingDeleted(facade: MeetingsFacade, router: Router, id: MeetingId): void {
  if (facade.busy() && facade.selectedMeeting()?.id === id) {
    void facade.cancelRecording().then(() => router.navigate(['/meetings']));
    return;
  }
  void facade.deleteMeeting(id).then(() => {
    if (facade.selectedMeeting() === undefined) {
      void router.navigate(['/meetings']);
    }
  });
}

/**
 * Wired to the detail pane's `retryRequested`, which is emitted from the
 * hoisted error banner regardless of which pane is showing — not just the
 * meeting-selected detail branch. With a meeting selected, "retry" means
 * re-opening it. With no meeting selected (e.g. an import rejected before
 * any placeholder meeting was created — see meeting-detail-pane.component.html),
 * re-opening is impossible, so retry instead just dismisses the error so the
 * user can try again from a clean state.
 */
export function runErrorRetry(facade: MeetingsFacade): void {
  const current = facade.selectedMeeting();
  if (current) {
    void facade.openMeeting(current.id);
  } else {
    facade.clearError();
  }
}

/**
 * Single-flight summarize: one click issues one `summarizeMeeting`. The
 * pane's Regenerate path used to emit on both outputs, firing the shell
 * handler twice per click; the second call hit Rust's `summary_busy` guard
 * (state.rs) and surfaced a BUSY error. Re-entrant calls while a generation
 * is already in flight are dropped up front.
 */
export function runSummarize(facade: MeetingsFacade, templateName: string): void {
  if (facade.summarizing()) {
    return;
  }
  const meeting = facade.selectedMeeting();
  const template = facade.templates().find((candidate) => candidate.name === templateName);
  if (!meeting || !template) {
    return;
  }
  void facade.summarizeMeeting(meeting.id, template);
}

/**
 * Label for the transcript toolbar's Undo button — the standing
 * `TRANSCRIPT_UNDO` slot rendered via `describeTranscriptOp`, or `null` when
 * nothing structural is undoable (button hidden).
 */
export const describeLatestTranscriptUndo = (op: TranscriptOp | null): string | null =>
  op === null ? null : describeTranscriptOp(op);

/**
 * Label for the speaker toolbar's Undo button — the TOP of the
 * `SPEAKER_HISTORY` stack rendered via `describeSpeakerOp` (undo pops the
 * top), or `null` when the stack is empty (button hidden).
 */
export function describeLatestSpeakerUndo(history: readonly SpeakerOp[]): string | null {
  const op = history.at(-1);
  return op === undefined ? null : describeSpeakerOp(op);
}

/**
 * Loads the persisted consent on every launch; a `'granted'` result immediately
 * runs a throttled, non-blocking check. The consent read is this path's only
 * fallible step, and the call site's `void` would drop a rejection with zero
 * diagnostics — a transient `update_consent` IPC failure then reads in the
 * shipped app exactly like "the launch check never runs at all". So the
 * failure is caught and logged here; the store keeps `'unset'`, and no check
 * fires without a confirmed `'granted'` (consent is never inferred).
 */
export async function loadUpdatesOnLaunch(facade: MeetingsFacade): Promise<void> {
  try {
    await facade.updates.loadConsent();
  } catch (caught) {
    console.error('[update] launch consent read failed; skipping the launch update check', caught);
    return;
  }
  if (facade.updates.consent() === 'granted') {
    void facade.updates.checkForUpdate(false);
  }
}

/** Every update-check template binding the shell needs, grouped behind one field to keep `MeetingsShellPage` under the max-lines cap. */
export interface UpdateHandlers {
  /** First-run (and every-launch-until-decided) consent-modal visibility; suppressed while `busy()` too. */
  readonly visible: Signal<boolean>;
  readonly onGranted: () => void;
  readonly onDeclined: () => void;
  readonly onPostponed: () => void;
  readonly onConsentChanged: (consent: UpdateConsent) => void;
  readonly onCheckNow: () => void;
  readonly onBannerDismissed: () => void;
  /** Kicks the facade's never-throwing install state machine (banner [Update] / [Retry]). */
  readonly onUpdate: () => void;
  /** Applies a ready update; a rejected `restart_app` lands in {@link restartError} instead of throwing. */
  readonly onRestart: () => void;
  /** Message from the last rejected restart, shown by the banner in the ready state; `null` hides it. */
  readonly restartError: Signal<string | null>;
  /** True from the first `onRestart` click until a rejection clears it — success never resolves (Rust relaunches), so it stays pending by design; drives the banner's disabled state alongside `busy()`. */
  readonly restarting: Signal<boolean>;
}

/** Builds {@link UpdateHandlers} bound to `facade`. "Turn on update checks" persists consent THEN immediately runs the first check; the settings toggle and × / Esc never check. */
export function createUpdateHandlers(facade: MeetingsFacade): UpdateHandlers {
  const restartError = signal<string | null>(null);
  const restarting = signal(false);
  return {
    visible: computed(() => facade.updates.consent() === 'unset' && !facade.busy()),
    onGranted: () => {
      void facade.updates.grantConsent().then(() => facade.updates.checkForUpdate(false));
    },
    onDeclined: () => void facade.updates.declineConsent(),
    onPostponed: () => undefined,
    onConsentChanged: (consent) => {
      if (consent === 'granted') {
        void facade.updates.grantConsent();
      } else {
        void facade.updates.declineConsent();
      }
    },
    onCheckNow: () => void facade.updates.checkForUpdate(true),
    onBannerDismissed: () => facade.updates.dismissBanner(),
    onUpdate: () => void facade.updates.installUpdate(),
    onRestart: () => {
      if (restarting()) {
        return;
      }
      restarting.set(true);
      restartError.set(null);
      facade.updates.restartApp().catch((caught: unknown) => {
        restarting.set(false);
        restartError.set(caught instanceof Error ? caught.message : String(caught));
      });
    },
    restartError: restartError.asReadonly(),
    restarting: restarting.asReadonly(),
  };
}

/**
 * Serialises backend meeting mutations. Speaker handlers can fire in the
 * same synchronous tick — a New-speaker commit emits reassign THEN rename —
 * and every op is an unlocked read-modify-write of meeting.json on the Rust
 * side, so overlapping them loses a write. An op arriving while the queue is
 * idle is dispatched IMMEDIATELY (single-op callers keep their synchronous
 * dispatch); later ops chain behind the in-flight one. Facade ops never
 * reject (errors land in the store's ERROR slot), but rejections are
 * swallowed anyway so no future rejecting path can wedge the chain.
 */
export class MeetingOpQueue {
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  /** Queues `run` against `meeting` — a no-op when nothing is selected. */
  enqueue(meeting: Meeting | undefined, run: (id: MeetingId) => Promise<void>): void {
    if (meeting === undefined) {
      return;
    }
    this.queued += 1;
    this.tail = this.queued === 1
      ? run(meeting.id).catch(() => undefined)
      : this.tail.then(() => run(meeting.id)).catch(() => undefined);
    void this.tail.then(() => {
      this.queued -= 1;
    });
  }
}

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
}

/**
 * Builds the settings-modal controls. Every open path (gear toggle, native
 * "Settings…" menu request) closes About, and the shell's `toggleAbout`
 * closes Settings via {@link SettingsControls.closeSettings} — the two
 * modals are mutually exclusive in both directions. The error callback keeps
 * a missing Tauri event bridge (headless specs; a release where `listen()`
 * cannot register) from crashing boot — the gear button opens Settings
 * regardless.
 */
export function createSettingsControls(
  facade: MeetingsFacade,
  showAbout: WritableSignal<boolean>,
  destroyRef: DestroyRef,
): SettingsControls {
  const showSettings = signal(false);
  const openSettings = (): void => {
    showAbout.set(false);
    showSettings.set(true);
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
  };
}

/**
 * Per-request summary-instructions wiring, grouped so `MeetingsShellPage`
 * stays under the 400-line `max-lines` cap. `drafts` is keyed by template
 * name for the SELECTED meeting (the pane owns the active tab); every facade
 * read happens inside a `computed`, so store slot writes re-derive it
 * reactively. `onDraftChanged` persists through the synchronous
 * `facade.setSummaryInstructionDraft` — a no-op when nothing is selected.
 */
export interface SummaryInstructionControls {
  readonly drafts: Signal<ReadonlyMap<string, SummaryInstructionsDraft>>;
  readonly onDraftChanged: (event: SummaryDraftChange) => void;
}

/** Builds {@link SummaryInstructionControls} bound to `facade`. */
export function createSummaryInstructionControls(facade: MeetingsFacade): SummaryInstructionControls {
  return {
    drafts: computed(() => {
      const meeting = facade.selectedMeeting();
      const drafts = new Map<string, SummaryInstructionsDraft>();
      if (meeting === undefined) {
        return drafts;
      }
      for (const template of facade.templates()) {
        drafts.set(template.name, facade.summaryInstructionDraft(meeting.id, template.name));
      }
      return drafts;
    }),
    onDraftChanged: (event) => {
      const meeting = facade.selectedMeeting();
      if (meeting !== undefined) {
        facade.setSummaryInstructionDraft(meeting.id, event.template, event.draft);
      }
    },
  };
}

/**
 * Split/detail + sidebar layout wiring, grouped so `MeetingsShellPage`
 * stays under the 400-line `max-lines` cap. Owns every layout `facade`
 * call — the splitter and the detail pane below the shell stay dumb.
 */
export interface LayoutControls {
  readonly onSplitRatioChanged: (ratio: number) => void;
  readonly onTranscriptCollapsedChanged: (collapsed: boolean) => void;
  readonly onSidebarWidthChanged: (width: number) => void;
  readonly onSidebarCollapsedChanged: (collapsed: boolean) => void;
  /** Cmd/Ctrl+B toggles the sidebar (ignored inside editable fields); Escape collapses it, but only in the narrow fallback — see `closeSidebarOnEscape`. */
  readonly onWindowKeydown: (event: KeyboardEvent) => void;
}

/** Builds {@link LayoutControls} bound to `facade`. */
export function createLayoutControls(facade: MeetingsFacade): LayoutControls {
  return {
    onSplitRatioChanged: (ratio) => facade.setSplitRatio(ratio),
    onTranscriptCollapsedChanged: (collapsed) => facade.setTranscriptCollapsed(collapsed),
    onSidebarWidthChanged: (width) => facade.setSidebarWidth(width),
    onSidebarCollapsedChanged: (collapsed) => facade.setSidebarCollapsed(collapsed),
    onWindowKeydown: (event) => {
      if (event.key === 'Escape') {
        closeSidebarOnEscape(facade, event);
        return;
      }
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'b') {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
        return;
      }
      event.preventDefault();
      facade.setSidebarCollapsed(!facade.sidebarCollapsed());
    },
  };
}
