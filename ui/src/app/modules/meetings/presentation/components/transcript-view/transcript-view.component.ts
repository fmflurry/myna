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

import {
  speakerAccentIndex,
  speakerDisplayName,
  speakerRole,
  speakerSubId,
  type Speaker,
  type Transcript,
} from '../../../core/models/transcript.model';
import { formatMmSs } from '../../utils/format-display.util';
import { EditableSegmentComponent } from '../editable-segment/editable-segment.component';
import {
  computeAnchoredMenuPosition,
  speakerReassignOptions,
  type AnchoredMenuPosition,
  type SpeakerReassignOption,
} from './transcript-view.component.support';

/** Size of the fixed CSS accent palette; see `.speaker-accent-N` in the stylesheet. */
const SPEAKER_ACCENT_PALETTE_SIZE = 6;

/** An inline edit committed for the segment at `index` in the current transcript. */
export interface TranscriptSegmentEdit {
  readonly index: number;
  readonly text: string;
}

/** A rename committed for the speaker label `label` (may be `'me'` or an `'others'` label). */
export interface SpeakerRename {
  readonly label: string;
  readonly name: string;
}

/** A speaker reassignment for the segment at `index` to `speaker`. */
export interface TranscriptSegmentSpeakerReassign {
  readonly index: number;
  readonly speaker: Speaker;
}

/** One speaker assigned to EVERY segment a text selection intersected. */
export interface TranscriptSelectionSpeakerAssignment {
  readonly indices: readonly number[];
  readonly speaker: Speaker;
}

/** One row of a speaker picker popup. */
interface SpeakerMenuItem {
  readonly key: string;
  readonly text: string;
  readonly action: () => void;
}

/**
 * Rendering of a persisted meeting transcript with mm:ss timestamps. Each
 * segment's text is inline-editable via `EditableSegmentComponent` unless
 * `editable` is false (e.g. while the meeting is still recording). Each
 * segment also carries a speaker chip that opens a local popup menu for
 * reassigning, renaming, or removing speaker attribution — and dragging a
 * text selection across one or more segments opens a floating toolbar that
 * assigns one speaker to every intersected segment in one go.
 */
@Component({
  selector: 'app-transcript-view',
  imports: [EditableSegmentComponent],
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
  readonly speakerRenamed = output<SpeakerRename>();
  readonly speakerRemoved = output<string>();
  /** Emitted by the floating selection toolbar; one compound assignment for all `indices`. */
  readonly selectionSpeakerAssigned = output<TranscriptSelectionSpeakerAssignment>();

  /** Index of the segment whose speaker menu is currently open, or `null` when closed. */
  protected readonly openIndex = signal<number | null>(null);
  /** Viewport-clamped placement for the currently open chip menu, computed at click time. */
  protected readonly menuPosition = signal<AnchoredMenuPosition | null>(null);

  /** Segment indices the floating toolbar targets, ascending, empty when closed. */
  protected readonly selectionIndices = signal<readonly number[]>([]);
  protected readonly selectionMenuOpen = signal(false);
  protected readonly selectionPickerOpen = signal(false);
  /** Viewport-clamped placement for the floating toolbar, computed from the selection rect. */
  protected readonly selectionMenuPosition = signal<AnchoredMenuPosition | null>(null);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** The speaker label of the currently open segment, or `undefined` when no menu is open. */
  protected readonly openSpeaker = computed<Speaker | undefined>(() => {
    const index = this.openIndex();
    return index === null ? undefined : this.transcript()?.segments[index]?.speaker;
  });

  /**
   * The rename row shows for every attributed label — `'me'`, the bare
   * unassigned `'others'` pool, and any `'others:<id>'` — since the name
   * registry is keyed by flat label and the backend resolves `'others'`
   * exactly like any other key. `unknown` has no name to rename until it is
   * assigned (its chip is a call-to-action, not a label).
   */
  protected readonly showRenameRow = computed(() => {
    const speaker = this.openSpeaker();
    if (speaker === undefined) {
      return false;
    }
    return speakerRole(speaker) !== 'unknown';
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
    if (speaker === undefined) {
      return '';
    }
    return this.speakerNames()[speaker] ?? speakerDisplayName(speaker);
  });

  /**
   * AMBIGUOUS (spec only asserts membership via `toContain`, never order):
   * fixed order Me, Others (unassigned), known named identities, New
   * speaker…, then Remove speaker… when offered.
   */
  protected readonly menuItems = computed<readonly SpeakerMenuItem[]>(() => {
    const index = this.openIndex();
    if (index === null) {
      return [];
    }
    const items: SpeakerMenuItem[] = speakerReassignOptions(this.transcript(), this.speakerNames()).map(
      (option) => ({ key: option.key, text: option.text, action: () => this.reassign(index, option.speaker) }),
    );
    if (this.canRemoveSpeaker()) {
      items.push({ key: 'remove', text: 'Remove speaker…', action: () => this.removeSpeaker() });
    }
    return items;
  });

  /** Picker rows for the floating toolbar; `New speaker…` is minted when the picker opens. */
  protected readonly selectionPickerItems = computed<readonly SpeakerReassignOption[]>(() =>
    this.selectionPickerOpen() ? speakerReassignOptions(this.transcript(), this.speakerNames()) : [],
  );

  private readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.closeMenu();
      this.closeSelectionMenu();
    }
  };

  /**
   * Closes an open menu on any click outside it and its trigger. Uses
   * `closest()` on the event target rather than the injected host element, so
   * it works whether or not the fixture's root is attached to `document`.
   * Clicks inside the transcript never close the selection toolbar: a
   * drag-select ends with a trailing `click` on the selection's common
   * ancestor, which would otherwise dismiss the toolbar the instant it
   * opened — it is closed by its own next mouseup instead.
   */
  private readonly handleDocumentClick = (event: MouseEvent): void => {
    const target = event.target as HTMLElement | null;
    if (this.openIndex() !== null && !(target?.closest('.speaker-menu') || target?.closest('.speaker-chip'))) {
      this.closeMenu();
    }
    if (
      this.selectionMenuOpen() &&
      target instanceof Element &&
      !target.closest('.selection-menu') &&
      !target.closest('.transcript')
    ) {
      this.closeSelectionMenu();
    }
  };

  /**
   * Reads the live text selection after every mouseup: a real, non-empty
   * selection intersecting transcript segments opens the floating toolbar
   * above it (closing the chip menu — the two are mutually exclusive); a
   * collapsed or whitespace-only selection closes it.
   *
   * Mouseups that land on the toolbar itself are ignored outright: the
   * selection is still anchored in the transcript while the toolbar is open,
   * so re-running the logic would close and reopen the menu mid-click,
   * detaching the picker item before its `click` dispatches (Chrome then
   * suppresses the click) and making the trigger impossible to toggle-close.
   * The toolbar manages its own mouseups — mirrors `handleDocumentClick`.
   */
  private readonly handleDocumentMouseup = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest('.selection-menu')) {
      return;
    }
    const selection = window.getSelection();
    if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
      this.closeSelectionMenu();
      return;
    }
    if (selection.toString().trim().length === 0) {
      this.closeSelectionMenu();
      return;
    }
    if (!this.editable()) {
      return;
    }
    const range = selection.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const anchorElement = anchor instanceof Element ? anchor : anchor.parentElement;
    if (anchorElement?.closest('.speaker-menu, .speaker-chip, .selection-menu')) {
      return;
    }
    const indices: number[] = [];
    for (const li of this.host.nativeElement.querySelectorAll<HTMLElement>('li[data-segment-index]')) {
      if (range.intersectsNode(li)) {
        const parsed = Number.parseInt(li.getAttribute('data-segment-index') ?? '', 10);
        if (!Number.isNaN(parsed)) {
          indices.push(parsed);
        }
      }
    }
    if (indices.length === 0) {
      this.closeSelectionMenu();
      return;
    }
    // jsdom's Range has no getBoundingClientRect at all; the menu still
    // opens, just without an inline anchor (real browsers always have one).
    const rect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : null;
    this.closeMenu();
    this.closeSelectionMenu();
    this.selectionIndices.set(indices);
    this.selectionMenuPosition.set(rect === null ? null : computeAnchoredMenuPosition(rect, true));
    this.selectionMenuOpen.set(true);
  };

  /** The toolbar is anchored to a viewport rect that scrolling invalidates. */
  private readonly handleDocumentScroll = (): void => {
    this.closeSelectionMenu();
  };

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
   * `''` for `unknown` — renderers must never fabricate attribution the app
   * doesn't have. For every attributed label the user's registered display
   * name (when set via rename) wins over the derived `'Others 1'`-style
   * label, so a committed rename is visible immediately on the chip.
   */
  speakerLabel(speaker: Speaker): string {
    return this.speakerNames()[speaker] ?? speakerDisplayName(speaker);
  }

  /** Whether `speaker` carries real attribution chrome should render for. */
  hasSpeakerLabel(speaker: Speaker): boolean {
    return speakerRole(speaker) !== 'unknown';
  }

  /** Stable CSS accent class for `speaker`, from the fixed-size palette. */
  speakerAccentClass(speaker: Speaker): string {
    return `speaker-accent-${speakerAccentIndex(speaker, SPEAKER_ACCENT_PALETTE_SIZE)}`;
  }

  /** Combined class list for the chip button: base + accent + `.speaker-label` when attributed. */
  protected chipClass(speaker: Speaker): string {
    const classes = ['speaker-chip', this.speakerAccentClass(speaker)];
    if (this.hasSpeakerLabel(speaker)) {
      classes.push('speaker-label');
    }
    return classes.join(' ');
  }

  /** Visible chip text: the resolved label, or a call-to-action for `unknown` (never fabricated attribution). */
  protected chipLabel(speaker: Speaker): string {
    return this.hasSpeakerLabel(speaker) ? this.speakerLabel(speaker) : 'Assign speaker';
  }

  /** Toggles the menu for `index`: closes it if already open there, else opens it positioned off the clicked chip. */
  protected onChipClick(event: MouseEvent, index: number): void {
    if (this.openIndex() === index) {
      this.closeMenu();
      return;
    }
    const chip = event.currentTarget as HTMLElement;
    this.closeSelectionMenu();
    this.menuPosition.set(computeAnchoredMenuPosition(chip.getBoundingClientRect(), false));
    this.openIndex.set(index);
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

  private reassign(index: number, speaker: Speaker): void {
    this.segmentSpeakerReassigned.emit({ index, speaker });
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

  /** Opens/closes the speaker picker anchored to the floating selection toolbar. */
  protected onSelectionTriggerClick(): void {
    this.selectionPickerOpen.set(!this.selectionPickerOpen());
  }

  /** Assigns the picked speaker to every selected segment, then drops the selection and closes. */
  protected onSelectionPickerSelect(option: SpeakerReassignOption): void {
    this.selectionSpeakerAssigned.emit({ indices: this.selectionIndices(), speaker: option.speaker });
    window.getSelection()?.removeAllRanges();
    this.closeSelectionMenu();
  }

  private closeMenu(): void {
    this.openIndex.set(null);
    this.menuPosition.set(null);
  }

  private closeSelectionMenu(): void {
    this.selectionMenuOpen.set(false);
    this.selectionPickerOpen.set(false);
    this.selectionIndices.set([]);
    this.selectionMenuPosition.set(null);
  }
}
