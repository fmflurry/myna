import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import { RemoveSpeakerUseCase } from '../use-cases/remove-speaker.usecase';
import { RenameSpeakerUseCase } from '../use-cases/rename-speaker.usecase';
import { SetSegmentSpeakerUseCase } from '../use-cases/set-segment-speaker.usecase';
import { MeetingsStore } from '../stores/meetings.store';
import {
  runRemoveSpeakerWithHistory,
  runRenameSpeakerWithHistory,
  runSetSegmentSpeakerWithHistory,
  runSetSegmentSpeakersWithHistory,
  runUndoLastSpeakerOp,
} from './meetings-facade-speaker-history.support';

/**
 * Speaker-operation undo plumbing, split out of `MeetingsFacade` to stay
 * under the project's max-lines limit. Every method is a thin delegation to
 * `meetings-facade-speaker-history.support.ts`, which owns the full
 * orchestration. Injected directly by `MeetingsFacade`, never by a
 * component — see the module's facade-pattern rule.
 */
@Injectable()
export class SpeakerFacade {
  private readonly store = inject(MeetingsStore);
  private readonly renameSpeakerUseCase = inject(RenameSpeakerUseCase);
  private readonly removeSpeakerUseCase = inject(RemoveSpeakerUseCase);
  private readonly setSegmentSpeakerUseCase = inject(SetSegmentSpeakerUseCase);

  readonly speakerHistory = this.store.speakerHistory;

  async renameSpeaker(id: MeetingId, label: string, name: string): Promise<void> {
    await runRenameSpeakerWithHistory(this.store, this.renameSpeakerUseCase, id, label, name);
  }

  async removeSpeaker(id: MeetingId, label: string): Promise<void> {
    await runRemoveSpeakerWithHistory(this.store, this.removeSpeakerUseCase, id, label);
  }

  async setSegmentSpeaker(id: MeetingId, index: number, speaker: string): Promise<void> {
    await runSetSegmentSpeakerWithHistory(this.store, this.setSegmentSpeakerUseCase, id, index, speaker);
  }

  async setSegmentSpeakers(id: MeetingId, indices: readonly number[], speaker: string): Promise<void> {
    await runSetSegmentSpeakersWithHistory(this.store, this.setSegmentSpeakerUseCase, id, indices, speaker);
  }

  async undoLastSpeakerOp(): Promise<void> {
    await runUndoLastSpeakerOp(this.store, this.renameSpeakerUseCase, this.removeSpeakerUseCase, this.setSegmentSpeakerUseCase);
  }
}
