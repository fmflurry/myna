import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import { DeleteTranscriptSegmentUseCase } from '../use-cases/delete-transcript-segment.usecase';
import { MergeTranscriptSegmentUpUseCase } from '../use-cases/merge-transcript-segment-up.usecase';
import { RestoreTranscriptSegmentsUseCase } from '../use-cases/restore-transcript-segments.usecase';
import { MeetingsStore } from '../stores/meetings.store';
import {
  runDeleteTranscriptSegmentWithHistory,
  runMergeTranscriptSegmentUpWithHistory,
  runUndoLastTranscriptOp,
} from './meetings-facade-transcript-history.support';

/**
 * Transcript structural-mutation (delete / merge-up) undo plumbing, split
 * out of `MeetingsFacade` to stay under the project's max-lines limit. Every
 * method is a thin delegation to
 * `meetings-facade-transcript-history.support.ts`, which owns the full
 * orchestration. Injected directly by `MeetingsFacade`, never by a
 * component — see the module's facade-pattern rule.
 */
@Injectable()
export class TranscriptEditingFacade {
  private readonly store = inject(MeetingsStore);
  private readonly deleteTranscriptSegmentUseCase = inject(DeleteTranscriptSegmentUseCase);
  private readonly mergeTranscriptSegmentUpUseCase = inject(MergeTranscriptSegmentUpUseCase);
  private readonly restoreTranscriptSegmentsUseCase = inject(RestoreTranscriptSegmentsUseCase);

  readonly transcriptUndo = this.store.transcriptUndo;

  async deleteTranscriptSegment(id: MeetingId, index: number, expectedText: string): Promise<void> {
    await runDeleteTranscriptSegmentWithHistory(this.store, this.deleteTranscriptSegmentUseCase, id, index, expectedText);
  }

  async mergeTranscriptSegmentUp(id: MeetingId, index: number, expectedText: string): Promise<void> {
    await runMergeTranscriptSegmentUpWithHistory(this.store, this.mergeTranscriptSegmentUpUseCase, id, index, expectedText);
  }

  async undoLastTranscriptOp(): Promise<void> {
    await runUndoLastTranscriptOp(this.store, this.restoreTranscriptSegmentsUseCase);
  }
}
