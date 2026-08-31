import { ChangeDetectionStrategy, Component, type OnDestroy, computed, input, output, signal } from '@angular/core';

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
import { knownSpeakerIdentities, mintNewSpeakerLabel } from './transcript-view.component.support';

/** Size of the fixed CSS accent palette; see `.speaker-accent-N` in the stylesheet. */
const SPEAKER_ACCENT_PALETTE_SIZE = 6;

/** Minimum on-screen margin the speaker menu must keep from any viewport edge. */
const VIEWPORT_MARGIN_PX = 8;
/** Assumed menu width used only to decide whether the left edge needs clamping (jsdom never lays out real width). */
const MENU_ESTIMATED_WIDTH_PX = 220;
/** Below this much space under the chip, the menu flips to a dropup. */
const MENU_FLIP_THRESHOLD_PX = 160;
/** Gap between the chip and the menu. */
const MENU_ANCHOR_GAP_PX = 4;
/** Floor for the computed max-height so a menu near a cramped edge still shows something. */
const MENU_MIN_HEIGHT_PX = 120;

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

/** One row of the speaker chip's popup menu. */
interface SpeakerMenuItem {
  readonly key: string;
  readonly text: string;
  readonly action: () => void;
}

/** Computed, viewport-clamped placement for the open speaker menu. */
interface SpeakerMenuPosition {
  readonly left: number;
  readonly top: number | null;
  readonly bottom: number | null;
  readonly maxHeight: number;
  readonly dropup: boolean;
}

/**
 * Rendering of a persisted meeting transcript with mm:ss timestamps. Each
 * segment's text is inline-editable via `EditableSegmentComponent` unless
 * `editable` is false (e.g. while the meeting is still recording). Each
 * segment also carries a speaker chip that opens a local popup menu for
 * reassigning, renaming, or removing speaker attribution.
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

  /** Index of the segment whose speaker menu is currently open, or `null` when closed. */
  protected readonly openIndex = signal<number | null>(null);
  /** Viewport-clamped placement for the currently open menu, computed at click time. */
  protected readonly menuPosition = signal<SpeakerMenuPosition | null>(null);

  /** The speaker label of the currently open segment, or `undefined` when no menu is open. */
  protected readonly openSpeaker = computed<Speaker | undefined>(() => {
    const index = this.openIndex();
    return index === null ? undefined : this.transcript()?.segments[index]?.speaker;
  });

  /**
   * AMBIGUOUS (spec asserts both cases, no unifying rule stated beyond this):
   * the rename row shows for a `'me'` label regardless of sub-identity, or
   * for any label carrying a sub-identity (named "others" speakers).
   */
  protected readonly showRenameRow = computed(() => {
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
    const items: SpeakerMenuItem[] = [
      { key: 'me', text: 'Me', action: () => this.reassign(index, 'me') },
      { key: 'others', text: 'Others (unassigned)', action: () => this.reassign(index, 'others') },
      ...knownSpeakerIdentities(this.speakerNames()).map((identity) => ({
        key: identity.label,
        text: identity.name,
        action: () => this.reassign(index, identity.label),
      })),
      {
        key: 'new',
        text: 'New speaker…',
        action: () => this.reassign(index, mintNewSpeakerLabel(this.transcript(), this.speakerNames())),
      },
    ];
    if (this.canRemoveSpeaker()) {
      items.push({ key: 'remove', text: 'Remove speaker…', action: () => this.removeSpeaker() });
    }
    return items;
  });

  private readonly handleDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      this.closeMenu();
    }
  };

  /**
   * Closes the open speaker menu on any click outside both the menu and its
   * triggering chip. Uses `closest()` on the event target rather than an
   * injected `ElementRef` (this component takes zero dependencies), so it
   * works whether or not the fixture's root is attached to `document`.
   */
  private readonly handleDocumentClick = (event: MouseEvent): void => {
    if (this.openIndex() === null) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest('.speaker-menu') || target?.closest('.speaker-chip')) {
      return;
    }
    this.closeMenu();
  };

  constructor() {
    document.addEventListener('keydown', this.handleDocumentKeydown);
    document.addEventListener('click', this.handleDocumentClick);
  }

  ngOnDestroy(): void {
    document.removeEventListener('keydown', this.handleDocumentKeydown);
    document.removeEventListener('click', this.handleDocumentClick);
  }

  formatTimestamp(seconds: number): string {
    return formatMmSs(seconds);
  }

  protected onSegmentEdited(index: number, text: string): void {
    this.segmentEdited.emit({ index, text });
  }

  /** `''` for `unknown` — renderers must never fabricate attribution the app doesn't have. */
  speakerLabel(speaker: Speaker): string {
    return speakerDisplayName(speaker);
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
    this.menuPosition.set(this.computeMenuPosition(chip.getBoundingClientRect()));
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

  private closeMenu(): void {
    this.openIndex.set(null);
    this.menuPosition.set(null);
  }

  /**
   * Reads `chip.getBoundingClientRect()` at click time and derives a
   * viewport-clamped placement: flips to a dropup when there isn't enough
   * room below, and clamps the left edge to stay within `VIEWPORT_MARGIN_PX`
   * of either edge (using an estimated width since jsdom never lays out a
   * real one).
   */
  private computeMenuPosition(chipRect: DOMRect): SpeakerMenuPosition {
    const spaceBelow = window.innerHeight - chipRect.bottom;
    const dropup = spaceBelow < MENU_FLIP_THRESHOLD_PX;

    let left = chipRect.left;
    if (left + MENU_ESTIMATED_WIDTH_PX > window.innerWidth - VIEWPORT_MARGIN_PX) {
      left = window.innerWidth - MENU_ESTIMATED_WIDTH_PX - VIEWPORT_MARGIN_PX;
    }
    left = Math.min(Math.max(left, VIEWPORT_MARGIN_PX), window.innerWidth - VIEWPORT_MARGIN_PX);

    if (dropup) {
      const maxHeight = Math.max(chipRect.top - VIEWPORT_MARGIN_PX, MENU_MIN_HEIGHT_PX);
      return { left, top: null, bottom: window.innerHeight - chipRect.top + MENU_ANCHOR_GAP_PX, maxHeight, dropup };
    }
    const maxHeight = Math.max(spaceBelow - VIEWPORT_MARGIN_PX, MENU_MIN_HEIGHT_PX);
    return { left, top: chipRect.bottom + MENU_ANCHOR_GAP_PX, bottom: null, maxHeight, dropup };
  }
}
