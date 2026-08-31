import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import { describeSpeakerOp, type SpeakerOp } from '../../../application/stores/speaker-history.model';
import type { SpeakerRename } from '../transcript-view/transcript-view.component';
import { knownSpeakerIdentities } from '../transcript-view/transcript-view.component.support';

/** One row of the speakers panel: the local participant or a named identity. */
interface SpeakerRow {
  readonly label: string;
  readonly name: string;
  readonly removable: boolean;
}

/**
 * Lists the local participant ("Me") plus every known named speaker identity
 * for the selected meeting, with per-row rename, per-row remove (confirmed),
 * and a session-scoped undo control describing the last speaker op. Reads
 * signals only — every write goes through the parent, which owns the facade.
 */
@Component({
  selector: 'app-speakers-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './speakers-panel.component.html',
  styleUrl: './speakers-panel.component.scss',
})
export class SpeakersPanelComponent {
  /** The selected meeting's display-name registry, keyed by flat speaker label. */
  readonly speakerNames = input<Readonly<Record<string, string>>>({});
  /** Session-scoped inverse-command stack for speaker ops; see `speaker-history.model.ts`. */
  readonly history = input<readonly SpeakerOp[]>([]);

  readonly speakerRenamed = output<SpeakerRename>();
  readonly speakerRemoved = output<string>();
  readonly undoRequested = output<void>();

  /** Me first, then the named "others" identities in stable name order. */
  protected readonly rows = computed<readonly SpeakerRow[]>(() => [
    { label: 'me', name: this.speakerNames()['me'] ?? '', removable: false },
    ...knownSpeakerIdentities(this.speakerNames()).map((identity) => ({
      label: identity.label,
      name: identity.name,
      removable: true,
    })),
  ]);

  /** Undo control label describing the last op (e.g. "Undo remove Jean"), or the bare fallback while the stack is empty. */
  protected readonly undoLabel = computed(() => {
    const last = this.history().at(-1);
    return last ? describeSpeakerOp(last) : 'Undo';
  });

  /** Commits a trimmed rename; a no-op when the value is unchanged. */
  protected commitRename(row: SpeakerRow, event: Event): void {
    const name = (event.target as HTMLInputElement).value.trim();
    if (name !== row.name) {
      this.speakerRenamed.emit({ label: row.label, name });
    }
  }

  /** Confirms, then emits `speakerRemoved` — the parent owns the actual removal. */
  protected remove(row: SpeakerRow): void {
    const subject = row.name === '' ? row.label : row.name;
    if (!window.confirm(`Remove speaker "${subject}"? Its segments return to Others (unassigned).`)) {
      return;
    }
    this.speakerRemoved.emit(row.label);
  }
}
