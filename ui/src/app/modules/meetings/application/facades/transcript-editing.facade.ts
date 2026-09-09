import { Injectable, inject } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import { MeetingsStore } from '../stores/meetings.store';
import { DeleteTranscriptSegmentUseCase } from '../use-cases/delete-transcript-segment.usecase';
import { EditLiveTranscriptSegmentUseCase } from '../use-cases/edit-live-transcript-segment.usecase';
import { EditTranscriptSegmentUseCase } from '../use-cases/edit-transcript-segment.usecase';
import { MergeTranscriptSegmentUpUseCase } from '../use-cases/merge-transcript-segment-up.usecase';
import { RestoreTranscriptSegmentsUseCase } from '../use-cases/restore-transcript-segments.usecase';
import {
  runDeleteTranscriptSegmentWithHistory,
  runDeleteTranscriptSectionWithHistory,
  runMergeTranscriptSegmentUpWithHistory,
  runUndoLastTranscriptOp,
} from './meetings-facade-transcript-history.support';
import { clearErrorFromSource, runGuarded, toErrorInfo } from './meetings-facade.support';

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
  private readonly editLiveSegmentUseCase = inject(EditLiveTranscriptSegmentUseCase);
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

  /**
   * Corrects one LIVE (still-recording) segment through the public store merge only
   * (no new store methods, keeping `meetings.store.ts` under its max-lines cap):
   * seeds an optimistic edited patch first (same `edited`/`originalText`/
   * `suspectReasons` semantics as the backend, so the triple-match replaces in
   * place), then the port write. On success merges the backend transcript (so
   * concurrent finals arriving mid-flight survive); on reject seeds the snapshot
   * segment back (clean-on-edited replaces back) and surfaces the failure in
   * `MeetingsError`. Never touches the persisted-meeting edit/undo pipeline.
   */
  async editLiveTranscriptSegment(id: MeetingId, index: number, text: string): Promise<void> {
    const previous = this.store.finalizedSegments();
    const current = previous[index];
    if (current !== undefined) {
      this.store.seedFinalizedSegments([
        { ...current, text, edited: true, originalText: current.originalText ?? current.text, suspectReasons: [] },
      ]);
    }
    try {
      const transcript = await this.editLiveSegmentUseCase.edit(id, index, text);
      this.store.seedFinalizedSegments(transcript.segments);
      clearErrorFromSource(this.store, 'editLiveTranscriptSegment');
    } catch (caught) {
      const snapshot = previous[index];
      if (snapshot !== undefined) {
        this.store.seedFinalizedSegments([snapshot]);
      }
      this.store.setError({ ...toErrorInfo(caught), source: 'editLiveTranscriptSegment' });
    }
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
