import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  type OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { speakerRole, speakerSubId, type Speaker, type Transcript } from '../../../core/models/transcript.model';
import { formatMmSs } from '../../utils/format-display.util';
import { EditableSegmentComponent } from '../editable-segment/editable-segment.component';
import {
  chipClasses,
  chipText,
  computeAnchoredMenuPosition,
  groupConsecutiveSegments, lineDeleteMessage,
  outsideClickClosures,
  readSelectionToolbarIntent,
  resolveSpeakerLabel,
  sectionDeleteMessage,
  speakerReassignOptions,
  type AnchoredMenuPosition,
  type SpeakerMenuItem,
  type SpeakerReassignOption,
  type SpeakerRename,
  type TranscriptSectionDelete,
  type TranscriptSelectionSpeakerAssignment,
  type TranscriptSegmentEdit,
  type TranscriptSegmentGroup,
  type TranscriptSegmentGroupSpeakerReassign,
  type TranscriptSegmentSpeakerReassign,
} from './transcript-view.component.support';
import { AutofocusDirective, NewSpeakerInput } from './transcript-view.component.new-speaker.support';

export type {
  SpeakerRename,
  TranscriptSectionDelete,
  TranscriptSelectionSpeakerAssignment,
  TranscriptSegmentEdit,
  TranscriptSegmentGroupSpeakerReassign,
  TranscriptSegmentSpeakerReassign,
} from './transcript-view.component.support';

/** Size of the fixed CSS accent palette; see `.speaker-accent-N` in the stylesheet. */
const SPEAKER_ACCENT_PALETTE_SIZE = 6;

/**
 * Renders a persisted transcript with mm:ss timestamps: each segment's text
 * is inline-editable (unless `editable` is false), each chip opens a popup
 * for reassigning/renaming/removing attribution, and dragging a text
 * selection across one or more segments opens a floating toolbar assigning
 * one speaker to every intersected segment in one go.
 */
@Component({
  selector: 'app-transcript-view',
  imports: [AutofocusDirective, EditableSegmentComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './transcript-view.component.html',
  styleUrl: './transcript-view.component.scss',
})
export class TranscriptViewComponent implements OnDestroy {
  readonly transcript = input<Transcript | undefined>(undefined);
  readonly editable = input(true);
  /** The selected meeting's display-name registry, keyed by flat speaker label. */
  readonly speakerNames = input<Readonly<Record<string, string>>>({});

  readonly segmentEdited = output<TranscriptSegmentEdit>();
  readonly segmentSpeakerReassigned = output<TranscriptSegmentSpeakerReassign>();
  /** Emitted instead of `segmentSpeakerReassigned` when the reassigned chip belongs to a MULTI-segment group. */
  readonly segmentGroupSpeakerReassigned = output<TranscriptSegmentGroupSpeakerReassign>();
  readonly speakerRenamed = output<SpeakerRename>();
  readonly speakerRemoved = output<string>();
  /** Emitted after the chip menu's confirm-guarded "Delete section…"; the parent owns persistence + undo. */
  readonly sectionDeleted = output<TranscriptSectionDelete>();
  /** Emitted by the floating selection toolbar; one compound assignment for all `indices`. */
  readonly selectionSpeakerAssigned = output<TranscriptSelectionSpeakerAssignment>();

  /** Consecutive same-speaker segments collapsed into single rendering blocks; see `groupConsecutiveSegments`. */
  protected readonly groups = computed<readonly TranscriptSegmentGroup[]>(() => groupConsecutiveSegments(this.transcript()));

  /** ABSOLUTE indices of every segment in the currently open group, or `[]` when closed. The first entry backs `openIndex`. */
  private readonly openIndices = signal<readonly number[]>([]);
  /** Index of the FIRST segment in the group whose speaker menu is currently open, or `null` when closed. */
  protected readonly openIndex = computed<number | null>(() => this.openIndices().at(0) ?? null);
  /** Viewport-clamped placement for the currently open menu, computed at click time. */
  protected readonly menuPosition = signal<AnchoredMenuPosition | null>(null);

  /** Segment indices the floating toolbar targets, ascending, empty when closed. */
  protected readonly selectionIndices = signal<readonly number[]>([]);
  protected readonly selectionMenuOpen = signal(false);
  protected readonly selectionPickerOpen = signal(false);
  /** Viewport-clamped placement for the floating toolbar, computed from the selection rect. */
  protected readonly selectionMenuPosition = signal<AnchoredMenuPosition | null>(null);

  /** Shared "New speaker…" inline name input — see `transcript-view.component.new-speaker.support.ts`. */
  protected readonly newSpeaker = new NewSpeakerInput({
    assign: (label) => {
      const chipIndices = this.openIndices();
      if (chipIndices.length > 0) {
        this.reassign(chipIndices, label);
        return true;
      }
      const selectionIndices = this.selectionIndices();
      if (selectionIndices.length === 0) {
        return false;
      }
      this.selectionSpeakerAssigned.emit({ indices: selectionIndices, speaker: label });
      window.getSelection()?.removeAllRanges();
      this.closeSelectionMenu();
      return true;
    },
    renamed: (label, name) => this.speakerRenamed.emit({ label, name }),
    closeAll: () => {
      this.closeMenu();
      this.closeSelectionMenu();
    },
  });

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The speaker label of the currently open segment, or `undefined` when no menu is open. */
  protected readonly openSpeaker = computed<Speaker | undefined>(() => {
    const index = this.openIndex();
    return index === null ? undefined : this.transcript()?.segments[index]?.speaker;
  });

  /** AMBIGUOUS (spec asserts both, no unifying rule stated): rename shows for a `'me'` label, or any label carrying a sub-identity (named "others" speakers). Hidden while the New-speaker name input is open so the menu never shows two competing inputs. */
  protected readonly showRenameRow = computed(() => {
    if (this.newSpeaker.pending() !== null) {
      return false;
    }
    const speaker = this.openSpeaker();
    if (speaker === undefined) {
      return false;
    }
    return speakerRole(speaker) === 'me' || speakerSubId(speaker) !== null;
  });

  /** Offered only for a sub-id "others" speaker — never for `me`, bare `others`, or `unknown`. */
  protected readonly canRemoveSpeaker = computed(() => {
    const speaker = this.openSpeaker();
    if (speaker === undefined) {
      return false;
    }
    return speakerRole(speaker) === 'others' && speakerSubId(speaker) !== null;
  });

  /** Rename input placeholder: the resolved display name, falling back to the derived one. */
  protected readonly renamePlaceholder = computed(() => {
    const speaker = this.openSpeaker();
    return speaker === undefined ? '' : resolveSpeakerLabel(speaker, this.speakerNames());
  });

  /** AMBIGUOUS (spec asserts membership via `toContain`, never order): Me, Others (unassigned), known named identities, New speaker…, then Remove speaker… when offered, then Delete section…. */
  protected readonly menuItems = computed<readonly SpeakerMenuItem[]>(() => {
    const indices = this.openIndices();
    if (indices.length === 0) {
      return [];
    }
    const items: SpeakerMenuItem[] = speakerReassignOptions(this.transcript(), this.speakerNames()).map((option) => ({
      key: option.key,
      text: option.text,
      // "New speaker…" reveals the inline name input instead of assigning the minted label silently.
      action: option.key === 'new' ? () => this.newSpeaker.begin(option.speaker) : () => this.reassign(indices, option.speaker),
    }));
    if (this.canRemoveSpeaker()) {
      items.push({ key: 'remove', text: 'Remove speaker…', action: () => this.removeSpeaker() });
    }
    items.push({
      key: 'delete',
      text: 'Delete section…',
      destructive: true,
      action: () => this.deleteSection(indices),
    });
    return items;
  });

  /** Picker rows for the floating toolbar; `New speaker…` is minted when the picker opens. */
  protected readonly selectionPickerItems = computed<readonly SpeakerReassignOption[]>(() =>
    this.selectionPickerOpen() ? speakerReassignOptions(this.transcript(), this.speakerNames()) : [],
  );

  private readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.closeMenu(); this.closeSelectionMenu();
    }
  };

  /** Closes an open menu on any click outside it and its trigger — see `outsideClickClosures`. */
  private readonly handleDocumentClick = (event: MouseEvent): void => {
    const { closeChip, closeSelection } = outsideClickClosures(
      event.target,
      this.openIndex() !== null,
      this.selectionMenuOpen(),
    );
    if (closeChip) {
      this.closeMenu();
    }
    if (closeSelection) {
      this.closeSelectionMenu();
    }
  };

  /**
   * Reads the live selection after every mouseup via `readSelectionToolbarIntent`:
   * a real selection opens the toolbar above it (closing the chip menu — the
   * two are mutually exclusive); a collapsed/whitespace-only one closes it.
   * Mouseups landing ON the toolbar are ignored outright: the selection is
   * still anchored in the transcript, so re-running the logic would close and
   * reopen the menu mid-click, detaching the picker item before its `click`
   * dispatches — Chrome then suppresses the click and the picker is dead.
   */
  private readonly handleDocumentMouseup = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest('.selection-menu')) {
      return;
    }
    const intent = readSelectionToolbarIntent(window.getSelection(), this.host.nativeElement, this.editable());
    if (intent.kind === 'ignore') {
      return;
    }
    if (intent.kind === 'close') {
      this.closeSelectionMenu();
      return;
    }
    this.closeMenu();
    this.closeSelectionMenu();
    this.selectionIndices.set(intent.indices);
    this.selectionMenuPosition.set(intent.rect === null ? null : computeAnchoredMenuPosition(intent.rect, true));
    this.selectionMenuOpen.set(true);
  };

  /** The toolbar is anchored to a viewport rect that scrolling invalidates. */
  private readonly handleDocumentScroll = (): void => this.closeSelectionMenu();

  constructor() {
    document.addEventListener('keydown', this.handleDocumentKeydown);
    document.addEventListener('click', this.handleDocumentClick);
    document.addEventListener('mouseup', this.handleDocumentMouseup);
    document.addEventListener('scroll', this.handleDocumentScroll, true);
    effect(() => {
      this.transcript();
      this.closeSelectionMenu();
    });
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.handleDocumentKeydown);
    document.removeEventListener('click', this.handleDocumentClick);
    document.removeEventListener('mouseup', this.handleDocumentMouseup);
    document.removeEventListener('scroll', this.handleDocumentScroll, true);
  }

  formatTimestamp(seconds: number): string {
    return formatMmSs(seconds);
  }

  protected onSegmentEdited(index: number, text: string): void {
    this.segmentEdited.emit({ index, text });
  }

  /**
   * Registry display name first (a rename must update EVERY chip for the
   * label), falling back to the derived label — the same precedence as
   * `renamePlaceholder`. `''` for `unknown` — renderers must never fabricate
   * attribution the app doesn't have.
   */
  protected speakerLabel(speaker: Speaker): string {
    return resolveSpeakerLabel(speaker, this.speakerNames());
  }

  /** Combined class list for the chip button: base + accent + `.speaker-label` when attributed. */
  protected chipClass(speaker: Speaker): string {
    return chipClasses(speaker, SPEAKER_ACCENT_PALETTE_SIZE);
  }

  /** Visible chip text: the resolved label, or a call-to-action for `unknown` (never fabricated attribution). */
  protected chipLabel(speaker: Speaker): string {
    return chipText(speaker, this.speakerNames());
  }

  /** ABSOLUTE indices of every entry in `group`, in order — the target set for a group-wide speaker reassign. */
  protected groupIndices(group: TranscriptSegmentGroup): readonly number[] {
    return group.entries.map((entry) => entry.index);
  }

  /** ABSOLUTE index of `group`'s first entry — `groupConsecutiveSegments` guarantees at least one entry per group. Used for tracking and to identify the group whose menu is open. */
  protected firstEntryIndex(group: TranscriptSegmentGroup): number {
    return group.entries[0]?.index ?? -1;
  }

  /** Toggles the menu for the group whose ABSOLUTE entry indices are `indices`: closes it if already open there, else opens it positioned off the clicked chip. */
  protected onChipClick(event: MouseEvent, indices: readonly number[]): void {
    const primary = indices.at(0) ?? null;
    if (this.openIndex() === primary) {
      this.closeMenu();
      return;
    }
    const chip = event.currentTarget as HTMLElement;
    this.closeSelectionMenu();
    this.menuPosition.set(computeAnchoredMenuPosition(chip.getBoundingClientRect(), false));
    this.openIndices.set(indices);
  }

  protected onRenameKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Enter') {
      return;
    }
    const speaker = this.openSpeaker();
    if (speaker === undefined) {
      return;
    }
    event.preventDefault();
    const name = (event.target as HTMLInputElement).value.trim();
    this.speakerRenamed.emit({ label: speaker, name });
    this.closeMenu();
  }

  /** Reassigns a single segment via `segmentSpeakerReassigned`, or a whole group via `segmentGroupSpeakerReassigned` as ONE logical change. */
  private reassign(indices: readonly number[], speaker: Speaker): void {
    if (indices.length === 1) {
      this.segmentSpeakerReassigned.emit({ index: indices[0]!, speaker });
    } else {
      this.segmentGroupSpeakerReassigned.emit({ indices, speaker });
    }
    this.closeMenu();
  }

  /** AMBIGUOUS (spec doesn't assert either way): the menu stays open on a declined confirmation. */
  private removeSpeaker(): void {
    const speaker = this.openSpeaker();
    if (speaker === undefined) {
      return;
    }
    const resolvedName = this.speakerNames()[speaker] ?? speaker;
    if (!window.confirm(`Remove speaker "${resolvedName}"? Its segments return to Others (unassigned).`)) {
      return;
    }
    this.speakerRemoved.emit(speaker);
    this.closeMenu();
  }

  /** Confirm-guarded removal of the whole visible section: emits `sectionDeleted` with the group's ABSOLUTE indices (the facade resolves CAS texts from the store). A declined confirmation emits nothing. */
  private deleteSection(indices: readonly number[]): void {
    const segments = this.transcript()?.segments;
    if (segments === undefined || indices.length === 0) {
      return;
    }
    if (!window.confirm(sectionDeleteMessage(indices, segments, (speaker) => this.speakerLabel(speaker)))) {
      return;
    }
    this.sectionDeleted.emit({ indices });
    this.closeMenu();
  }

  /** Confirm-guarded delete of ONE entry line. Reuses `sectionDeleted` with a 1-element list — the pane re-emit, shell handler, facade compound-undo op, and singular undo label already treat a single-index section as a single-segment delete, so no parallel pipeline is introduced. */
  protected deleteLine(index: number, text: string): void {
    if (!window.confirm(lineDeleteMessage(text))) {
      return;
    }
    this.sectionDeleted.emit({ indices: [index] });
    this.closeMenu();
  }

  /** Opens/closes the speaker picker anchored to the floating selection toolbar. */
  protected onSelectionTriggerClick(): void {
    this.selectionPickerOpen.set(!this.selectionPickerOpen());
  }

  /** Assigns the picked speaker to every selected segment, then drops the selection and closes. `New speaker…` instead reveals the shared inline name input. */
  protected onSelectionPickerSelect(option: SpeakerReassignOption): void {
    if (option.key === 'new') {
      this.newSpeaker.begin(option.speaker);
      return;
    }
    this.selectionSpeakerAssigned.emit({ indices: this.selectionIndices(), speaker: option.speaker });
    window.getSelection()?.removeAllRanges();
    this.closeSelectionMenu();
  }

  private closeMenu(): void {
    this.openIndices.set([]);
    this.menuPosition.set(null);
    this.newSpeaker.clear();
  }

  private closeSelectionMenu(): void {
    this.selectionMenuOpen.set(false);
    this.selectionPickerOpen.set(false);
    this.selectionIndices.set([]);
    this.selectionMenuPosition.set(null);
    this.newSpeaker.clear();
  }
}
