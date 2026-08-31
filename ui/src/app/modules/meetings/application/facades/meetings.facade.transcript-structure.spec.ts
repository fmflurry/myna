import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { Meeting } from '../../core/models/meeting.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { transcriptSegment } from '../testing/transcript-segment.factory';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { MeetingRepositoryPort } from '../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../core/ports/models-status.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { provideMeetings } from '../../meetings.providers';
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../testing/in-memory-file-dialog.fake';
import { InMemoryMeetingRepositoryFake } from '../testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsFacade } from './meetings.facade';

/**
 * `provideMeetings()` binds the real Tauri adapters (correct for the
 * shipped app), so every fake port used below is layered on top via
 * explicit overrides — this spec exercises the facade against fakes,
 * not against a live Tauri runtime. Mirrors
 * `meetings.facade.edit-segment.spec.ts`'s wiring exactly.
 */
const FAKE_PORT_OVERRIDES = [
  { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
  { provide: RecorderPort, useClass: InMemoryRecorderFake },
  { provide: SummarizerPort, useClass: InMemorySummarizerFake },
  { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
  { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
  { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
  { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
  { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
  { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
];

describe('MeetingsFacade transcript structural mutations + undo', () => {
  let facade: MeetingsFacade;
  let repository: InMemoryMeetingRepositoryFake;

  const meetingId = toMeetingId('m-1');

  // segments[0] and segments[1] share a speaker label so they can be merged;
  // segments[2] carries a different label so it cannot merge into segments[1].
  // speakerPinned differs across [0] and [1] so undo-restoring a merge can
  // assert each original flag comes back independently, not clobbered by the
  // other segment's value.
  const seededMeeting = {
    id: meetingId,
    title: 'Standup',
    createdAt: new Date(),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
    transcript: {
      segments: [
        transcriptSegment({ startSec: 0, endSec: 5, text: 'first', speaker: 'others:1', speakerPinned: false }),
        transcriptSegment({ startSec: 5, endSec: 10, text: 'second', speaker: 'others:1', speakerPinned: true }),
        transcriptSegment({ startSec: 10, endSec: 15, text: 'third', speaker: 'others', speakerPinned: false }),
      ],
    },
  };

  // `noUncheckedIndexedAccess` types every indexed read as `T | undefined`; these
  // fixed-length literal reads are always defined, so bind them once, typed, rather
  // than non-null-asserting at each call site.
  const originalFirstSegment = seededMeeting.transcript.segments[0]!;
  const originalSecondSegment = seededMeeting.transcript.segments[1]!;
  const originalThirdSegment = seededMeeting.transcript.segments[2]!;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    repository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
    repository.seed([seededMeeting]);
    await facade.loadMeetings();
    await facade.openMeeting(meetingId);
  });

  it('starts with an empty transcript-undo slot', () => {
    expect(facade.transcriptUndo()).toBeNull();
  });

  it('deletes a segment, populating TRANSCRIPT_UNDO only after the repository call resolves — never optimistically', async () => {
    let resolveDelete!: (meeting: Meeting) => void;
    const deferred = new Promise<Meeting>((resolve) => {
      resolveDelete = resolve;
    });
    vi.spyOn(repository, 'deleteTranscriptSegment').mockReturnValue(deferred);

    const pending = facade.deleteTranscriptSegment(meetingId, 2, 'third');
    // Still in flight: the slot must not be populated yet, and the visible
    // transcript must be unchanged (never optimistic).
    expect(facade.transcriptUndo()).toBeNull();
    expect(facade.selectedMeeting()?.transcript?.segments.map((segment) => segment.text)).toEqual([
      'first',
      'second',
      'third',
    ]);

    resolveDelete({
      ...seededMeeting,
      transcript: { segments: seededMeeting.transcript.segments.slice(0, 2) },
    });
    await pending;

    expect(facade.meetings()[0]?.transcript?.segments.map((segment) => segment.text)).toEqual(['first', 'second']);
    expect(facade.selectedMeeting()?.transcript?.segments.map((segment) => segment.text)).toEqual([
      'first',
      'second',
    ]);
    expect(facade.transcriptUndo()).toEqual({
      kind: 'delete',
      meetingId,
      index: 2,
      segment: originalThirdSegment,
    });
  });

  it('undo after a delete calls restoreTranscriptSegments with the original segment at its original index, then clears the slot', async () => {
    const restoreSpy = vi.spyOn(repository, 'restoreTranscriptSegments');

    await facade.deleteTranscriptSegment(meetingId, 2, 'third');
    await facade.undoLastTranscriptOp();

    expect(restoreSpy).toHaveBeenCalledWith(meetingId, 2, 0, [originalThirdSegment]);
    expect(facade.selectedMeeting()?.transcript?.segments.map((segment) => segment.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(facade.transcriptUndo()).toBeNull();
  });

  it('merges a segment up, capturing both original segments; undo restores both with individually preserved speakerPinned flags', async () => {
    const restoreSpy = vi.spyOn(repository, 'restoreTranscriptSegments');

    await facade.mergeTranscriptSegmentUp(meetingId, 1, 'second');

    expect(facade.selectedMeeting()?.transcript?.segments.map((segment) => segment.text)).toEqual([
      'first second',
      'third',
    ]);
    expect(facade.transcriptUndo()).toEqual({
      kind: 'merge',
      meetingId,
      index: 1,
      previous: originalFirstSegment,
      current: originalSecondSegment,
    });

    await facade.undoLastTranscriptOp();

    expect(restoreSpy).toHaveBeenCalledWith(meetingId, 0, 1, [
      originalFirstSegment,
      originalSecondSegment,
    ]);
    const restoredSegments = facade.selectedMeeting()?.transcript?.segments;
    expect(restoredSegments?.map((segment) => segment.text)).toEqual(['first', 'second', 'third']);
    expect(restoredSegments?.[0]?.speakerPinned).toBe(false);
    expect(restoredSegments?.[1]?.speakerPinned).toBe(true);
    expect(facade.transcriptUndo()).toBeNull();
  });

  it('a second structural op replaces the undo slot — only the latest op is undoable', async () => {
    await facade.deleteTranscriptSegment(meetingId, 2, 'third');
    expect(facade.transcriptUndo()?.kind).toBe('delete');

    await facade.mergeTranscriptSegmentUp(meetingId, 1, 'second');

    expect(facade.transcriptUndo()).toEqual({
      kind: 'merge',
      meetingId,
      index: 1,
      previous: originalFirstSegment,
      current: originalSecondSegment,
    });
  });

  it('openMeeting clears the undo slot; a subsequent undo is a no-op that never calls the repository', async () => {
    const meetingB = { ...seededMeeting, id: toMeetingId('m-2'), title: 'Other' };
    repository.seed([seededMeeting, meetingB]);
    await facade.deleteTranscriptSegment(meetingId, 2, 'third');
    expect(facade.transcriptUndo()).not.toBeNull();

    await facade.openMeeting(meetingB.id);
    expect(facade.transcriptUndo()).toBeNull();

    const restoreSpy = vi.spyOn(repository, 'restoreTranscriptSegments');
    await facade.undoLastTranscriptOp();

    expect(restoreSpy).not.toHaveBeenCalled();
    expect(facade.error()).toBeUndefined();
    expect(facade.selectedMeeting()?.id).toBe(meetingB.id);
  });

  it('clears SPEAKER_HISTORY after a delete — a shifted index would otherwise replay the wrong line', async () => {
    await facade.renameSpeaker(meetingId, 'others:1', 'Jeanne');
    expect(facade.speakerHistory().length).toBe(1);

    await facade.deleteTranscriptSegment(meetingId, 2, 'third');

    expect(facade.speakerHistory()).toEqual([]);
  });

  it('clears SPEAKER_HISTORY after a merge, for the same reason', async () => {
    await facade.renameSpeaker(meetingId, 'others:1', 'Jeanne');
    expect(facade.speakerHistory().length).toBe(1);

    await facade.mergeTranscriptSegmentUp(meetingId, 1, 'second');

    expect(facade.speakerHistory()).toEqual([]);
  });

  it('sets the error slot and leaves TRANSCRIPT_UNDO empty when the repository rejects a delete', async () => {
    vi.spyOn(repository, 'deleteTranscriptSegment').mockRejectedValueOnce(
      new MeetingsError('BUSY', 'Meeting is recording.'),
    );

    await facade.deleteTranscriptSegment(meetingId, 2, 'third');

    expect(facade.error()?.code).toBe('BUSY');
    expect(facade.transcriptUndo()).toBeNull();
    expect(facade.selectedMeeting()?.transcript?.segments.map((segment) => segment.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('sets the error slot and leaves TRANSCRIPT_UNDO empty when the repository rejects a merge', async () => {
    vi.spyOn(repository, 'mergeTranscriptSegmentUp').mockRejectedValueOnce(
      new MeetingsError('BUSY', 'Meeting is recording.'),
    );

    await facade.mergeTranscriptSegmentUp(meetingId, 1, 'second');

    expect(facade.error()?.code).toBe('BUSY');
    expect(facade.transcriptUndo()).toBeNull();
    expect(facade.selectedMeeting()?.transcript?.segments.map((segment) => segment.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});
