import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import { MeetingsStore } from '../stores/meetings.store';
import { DeleteTranscriptSegmentUseCase } from '../use-cases/delete-transcript-segment.usecase';
import { EditTranscriptSegmentUseCase } from '../use-cases/edit-transcript-segment.usecase';
import { MergeTranscriptSegmentUpUseCase } from '../use-cases/merge-transcript-segment-up.usecase';
import { RestoreTranscriptSegmentsUseCase } from '../use-cases/restore-transcript-segments.usecase';
import {
  runDeleteTranscriptSegmentWithHistory,
  runDeleteTranscriptSectionWithHistory,
  runMergeTranscriptSegmentUpWithHistory,
  runUndoLastTranscriptOp,
} from './meetings-facade-transcript-history.support';
import { runGuarded } from './meetings-facade.support';

/**
 * Transcript editing (inline text edit + structural delete / merge-up /
 * section-delete) undo plumbing, split out of `MeetingsFacade` to stay under
 * the project's max-lines limit. Every method is a thin delegation to
 * `meetings-facade-transcript-history.support.ts`, which owns the full
 * orchestration. Injected directly by `MeetingsFacade`, never by a
 * component — see the module's facade-pattern rule.
 */
@Injectable()
export class TranscriptEditingFacade {
  private readonly store = inject(MeetingsStore);
  private readonly editTranscriptSegmentUseCase = inject(EditTranscriptSegmentUseCase);
  private readonly deleteTranscriptSegmentUseCase = inject(DeleteTranscriptSegmentUseCase);
  private readonly mergeTranscriptSegmentUpUseCase = inject(MergeTranscriptSegmentUpUseCase);
  private readonly restoreTranscriptSegmentsUseCase = inject(RestoreTranscriptSegmentsUseCase);

  readonly transcriptUndo = this.store.transcriptUndo;

  /** Persists a manual correction to one transcript segment; never optimistic. Rejected with BUSY by the backend while that meeting is recording. */
  async editTranscriptSegment(id: MeetingId, index: number, text: string): Promise<void> {
    await runGuarded(
      this.store,
      async () => this.store.updateMeeting(await this.editTranscriptSegmentUseCase.edit(id, index, text)),
      'editTranscriptSegment',
    );
  }

  async deleteTranscriptSegment(id: MeetingId, index: number, expectedText: string): Promise<void> {
    await runDeleteTranscriptSegmentWithHistory(this.store, this.deleteTranscriptSegmentUseCase, id, index, expectedText);
  }

  /** Deletes a whole visible section (contiguous `indices`) as ONE compound undo step; see the support runner. */
  async deleteTranscriptSection(id: MeetingId, indices: readonly number[]): Promise<void> {
    await runDeleteTranscriptSectionWithHistory(this.store, this.deleteTranscriptSegmentUseCase, id, indices);
  }

  async mergeTranscriptSegmentUp(id: MeetingId, index: number, expectedText: string): Promise<void> {
    await runMergeTranscriptSegmentUpWithHistory(this.store, this.mergeTranscriptSegmentUpUseCase, id, index, expectedText);
  }

  async undoLastTranscriptOp(): Promise<void> {
    await runUndoLastTranscriptOp(this.store, this.restoreTranscriptSegmentsUseCase);
  }
}
