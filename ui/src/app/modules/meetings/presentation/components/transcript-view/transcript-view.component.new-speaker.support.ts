import { Directive, ElementRef, afterNextRender, inject, signal } from '@angular/core';

import type { Speaker } from '../../../core/models/transcript.model';

/** What an attempt to commit the New-speaker inline input resolves to. */
export type NewSpeakerDecision =
  /** Nothing pending (e.g. the native blur a removed input fires after a commit): touch nothing. */
  | { readonly kind: 'ignore' }
  /** Escape or an empty name: close the menu, assign nothing. */
  | { readonly kind: 'close' }
  /** A trimmed name for the minted label: assign FIRST, then rename. */
  | { readonly kind: 'assign'; readonly label: Speaker; readonly name: string };

/**
 * Pure decision for the "New speaker…" inline input shared by both pickers.
 * A commit with content assigns the minted `others:mN` label and then renames
 * it — the parent must receive the reassign BEFORE the rename keyed on that
 * label, so the label already exists in the transcript by the time the
 * display name is registered against it. Escape or an empty name closes
 * without assigning.
 */
export function decideNewSpeakerCommit(pendingLabel: Speaker | null, rawName: string): NewSpeakerDecision {
  if (pendingLabel === null) {
    return { kind: 'ignore' };
  }
  const name = rawName.trim();
  return name === '' ? { kind: 'close' } : { kind: 'assign', label: pendingLabel, name };
}

/** Component-owned actions the New-speaker flow drives. */
export interface NewSpeakerWiring {
  /** Assign the minted label to the open chip group or the selection batch; `false` when neither has targets. */
  readonly assign: (label: Speaker) => boolean;
  /** Register the typed display name for the just-assigned label (existing rename pipeline). */
  readonly renamed: (label: Speaker, name: string) => void;
  /** Dismiss both menus — the chip menu and the selection toolbar are mutually exclusive. */
  readonly closeAll: () => void;
}

/**
 * State machine behind the "New speaker…" inline name input, shared by the
 * chip menu and the floating selection toolbar (they are mutually exclusive,
 * so ONE instance serves both). `begin` captures the freshly minted label at
 * click time — a concurrent transcript change can't shift it under the open
 * menu; Enter or blur-with-content commits (assign THEN rename); Escape or an
 * empty name closes without assigning. `pending` drives the input's
 * visibility in both templates.
 */
export class NewSpeakerInput {
  /** The minted `others:mN` label awaiting a typed name, or `null` when the input is hidden. */
  readonly pending = signal<Speaker | null>(null);

  constructor(private readonly wiring: NewSpeakerWiring) {}

  /** Reveals the inline name input for `label` instead of assigning it silently. */
  begin(label: Speaker): void {
    this.pending.set(label);
  }

  onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      this.commit((event.target as HTMLInputElement).value);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      this.cancel();
    }
  }

  /**
   * Blur commits like Enter when there is content; the `ignore` decision stops the native blur fired while a committed input is removed from double-committing.
   * A blur INTO the open menu (the user clicked another item) never commits — the item's own click action must win, or the blur's assign+rename would double-fire
   * against it and orphan a phantom speaker. Only the pending label is dropped (`clear`, not `cancel`): closing the menu here would detach the very item whose
   * click is about to land.
   */
  onBlur(event: FocusEvent): void {
    if (event.relatedTarget instanceof Element && event.relatedTarget.closest('.speaker-menu, .selection-menu') !== null) {
      this.clear();
      return;
    }
    this.commit((event.target as HTMLInputElement).value);
  }

  cancel(): void {
    this.pending.set(null);
    this.wiring.closeAll();
  }

  /** Clear any pending label — called by every menu-close path so a stale input never reappears. */
  clear(): void {
    this.pending.set(null);
  }

  private commit(rawName: string): void {
    const decision = decideNewSpeakerCommit(this.pending(), rawName);
    this.pending.set(null);
    if (decision.kind === 'ignore') {
      return;
    }
    if (decision.kind === 'close' || !this.wiring.assign(decision.label)) {
      this.wiring.closeAll();
      return;
    }
    this.wiring.renamed(decision.label, decision.name);
  }
}

/**
 * Focuses its host element once, right after it is first rendered — i.e.
 * when the New-speaker inline input appears. Replaces the `autofocus`
 * attribute, which browsers ignore on dynamically inserted elements.
 */
@Directive({ selector: '[appAutofocus]' })
export class AutofocusDirective {
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  constructor() {
    afterNextRender(() => this.element.nativeElement.focus());
  }
}
