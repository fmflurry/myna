import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, convertToParamMap, type ParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { vi } from 'vitest';

import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { InMemoryAppInfoFake } from '../../../application/testing/in-memory-app-info.fake';
import { InMemoryFileDialogFake } from '../../../application/testing/in-memory-file-dialog.fake';
import { InMemoryFolderRepositoryFake } from '../../../application/testing/in-memory-folder-repository.fake';
import { InMemoryMeetingRepositoryFake } from '../../../application/testing/in-memory-meeting-repository.fake';
import { InMemoryModelsStatusFake } from '../../../application/testing/in-memory-models-status.fake';
import { InMemoryPreferencesFake } from '../../../application/testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../../../application/testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../../../application/testing/in-memory-summarizer.fake';
import { InMemoryTemplateRepositoryFake } from '../../../application/testing/in-memory-template-repository.fake';
import { InMemoryTranscriberFake } from '../../../application/testing/in-memory-transcriber.fake';
import type { FolderId } from '../../../core/models/folder.model';
import { toFolderId } from '../../../core/models/folder.model';
import type { Meeting } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingsError } from '../../../core/models/recording-state.model';
import { AppInfoPort } from '../../../core/ports/app-info.port';
import { FileDialogPort } from '../../../core/ports/file-dialog.port';
import { FolderRepositoryPort } from '../../../core/ports/folder-repository.port';
import { MeetingRepositoryPort } from '../../../core/ports/meeting-repository.port';
import { ModelsStatusPort } from '../../../core/ports/models-status.port';
import { PreferencesPort } from '../../../core/ports/preferences.port';
import { RecorderPort } from '../../../core/ports/recorder.port';
import { SummarizerPort } from '../../../core/ports/summarizer.port';
import { TemplateRepositoryPort } from '../../../core/ports/template-repository.port';
import { TranscriberPort } from '../../../core/ports/transcriber.port';
import { flushMicrotasks } from '../../../infrastructure/tauri/testing/tauri-internals.stub';
import { provideMeetings } from '../../../meetings.providers';
import { MeetingsShellPage } from './meetings-shell.page';

/**
 * Spec for the drag-and-drop coordinator handler on `MeetingsShellPage` —
 * `onMeetingMoveRequested(request: MeetingDragMoveRequest)`.
 *
 * Phase 2: every target kind now routes through the single-write
 * `facade.placeMeeting` (backed by `set_meeting_placement`), replacing the
 * old two-step unarchive-then-assign sequencing. Unlike the sibling
 * `meetings-shell.page.archive.spec.ts` / `.move.spec.ts` (which stub
 * `MeetingsFacade` entirely), the guarantee-level tests below mount the page
 * against the REAL `MeetingsFacade` layered on in-memory fakes — mirroring
 * `meetings.facade.folders.spec.ts` — because those guarantees (never
 * half-applying, preserving the meeting's folder on archive) are properties
 * of the end-to-end flow, not just of the routing decision. The routing-only
 * tests at the bottom spy on `facade.placeMeeting` directly, since that
 * decision lives in the shell page, not in `MeetingsFacade`/`runPlaceMeeting`.
 * `provideMeetings()` binds the real Tauri adapters (correct for the shipped
 * app); every fake port below is layered on top via explicit overrides.
 */
const FAKE_PORT_OVERRIDES = [
  { provide: MeetingRepositoryPort, useClass: InMemoryMeetingRepositoryFake },
  { provide: FolderRepositoryPort, useClass: InMemoryFolderRepositoryFake },
  { provide: RecorderPort, useClass: InMemoryRecorderFake },
  { provide: SummarizerPort, useClass: InMemorySummarizerFake },
  { provide: TranscriberPort, useClass: InMemoryTranscriberFake },
  { provide: TemplateRepositoryPort, useClass: InMemoryTemplateRepositoryFake },
  { provide: ModelsStatusPort, useClass: InMemoryModelsStatusFake },
  { provide: FileDialogPort, useClass: InMemoryFileDialogFake },
  { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
  { provide: AppInfoPort, useClass: InMemoryAppInfoFake },
];

describe('MeetingsShellPage — drag and drop move handling', () => {
  let facade: MeetingsFacade;
  let repository: InMemoryMeetingRepositoryFake;

  const baseMeeting = (id: string, overrides: { archived?: boolean; folderId?: FolderId } = {}): Meeting => ({
    id: toMeetingId(id),
    title: 'Standup',
    createdAt: new Date(2026, 7, 27),
    durationSec: 60,
    summaries: [],
    archived: overrides.archived ?? false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
    ...(overrides.folderId ? { folderId: overrides.folderId } : {}),
  });

  beforeEach(() => {
    const routeParamMap = new BehaviorSubject<ParamMap>(convertToParamMap({}));
    TestBed.configureTestingModule({
      providers: [
        provideMeetings(),
        ...FAKE_PORT_OVERRIDES,
        provideRouter([]),
        { provide: ActivatedRoute, useValue: { paramMap: routeParamMap } },
      ],
    });
    facade = TestBed.inject(MeetingsFacade);
    repository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
  });

  const createFixture = () => {
    const fixture = TestBed.createComponent(MeetingsShellPage);
    fixture.detectChanges();
    return fixture;
  };

  it('an archive target archives the meeting', async () => {
    // Arrange
    repository.seed([baseMeeting('m1')]);
    const fixture = createFixture();
    await flushMicrotasks();

    // Act
    fixture.componentInstance.onMeetingMoveRequested({ id: toMeetingId('m1'), target: { kind: 'archive' } });
    await flushMicrotasks();

    // Assert
    expect(facade.meetings()[0]?.archived).toBe(true);
  });

  it('a folder target on a non-archived meeting only assigns the folder — no unarchive call is made', async () => {
    // Arrange
    repository.seed([baseMeeting('m1')]);
    const fixture = createFixture();
    await flushMicrotasks();
    const setArchivedSpy = vi.spyOn(repository, 'setArchived');

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: { kind: 'folder', folderId: toFolderId('f1') },
    });
    await flushMicrotasks();

    // Assert
    expect(setArchivedSpy).not.toHaveBeenCalled();
    expect(facade.meetings()[0]?.folderId).toBe(toFolderId('f1'));
  });

  /**
   * OLD assertion (pre-Phase-2): `order` captured two sequential repository
   * calls — `setArchived` then `setFolder` — and both post-conditions were
   * checked against that two-step trail. NEW assertion: the single-write
   * `place` command is called exactly once with `archived: false` and the
   * target folder, and the guarantee it protects — an archived meeting
   * dragged into a folder ends up BOTH unarchived AND filed there — holds
   * against the resulting meeting state, not against a call trail.
   */
  it('a folder target on an archived meeting ends up both unarchived and filed in that folder', async () => {
    // Arrange
    repository.seed([baseMeeting('m1', { archived: true })]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeSpy = vi.spyOn(repository, 'place');

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: { kind: 'folder', folderId: toFolderId('f1') },
    });
    await flushMicrotasks();

    // Assert
    expect(placeSpy).toHaveBeenCalledTimes(1);
    expect(placeSpy).toHaveBeenCalledWith(toMeetingId('m1'), toFolderId('f1'), false, null, null);
    expect(facade.meetings()[0]?.archived).toBe(false);
    expect(facade.meetings()[0]?.folderId).toBe(toFolderId('f1'));
  });

  /**
   * OLD assertion: a rejected `setArchived` (the first of two steps) skips
   * the second `setFolder` call entirely, so the meeting is only ever
   * touched by the failed first step. NEW assertion: with one write instead
   * of two there is no second step to skip — the guarantee this protects is
   * that a rejected `place` call cannot half-apply, so the meeting is left
   * EXACTLY as it was (still archived, no folder) rather than partially
   * updated.
   */
  it('a rejected placement leaves the meeting exactly as it was (failure cannot half-apply)', async () => {
    // Arrange
    repository.seed([baseMeeting('m1', { archived: true })]);
    const fixture = createFixture();
    await flushMicrotasks();
    vi.spyOn(repository, 'place').mockRejectedValue(new MeetingsError('BUSY', 'Busy'));

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: { kind: 'folder', folderId: toFolderId('f1') },
    });
    await flushMicrotasks();

    // Assert
    expect(facade.error()?.code).toBe('BUSY');
    expect(facade.meetings()[0]?.archived).toBe(true);
    expect(facade.meetings()[0]?.folderId).toBeUndefined();
  });

  /**
   * OLD assertion: rejected the (first) `setArchived` step. NEW assertion:
   * rejects the single `place` write instead — the guarantee (a Busy
   * rejection leaves the meetings list byte-identical to its pre-drop value)
   * is unchanged.
   */
  it('a Busy rejection leaves the meetings list byte-identical to its pre-drop value', async () => {
    // Arrange
    repository.seed([baseMeeting('m1', { archived: true })]);
    const fixture = createFixture();
    await flushMicrotasks();
    vi.spyOn(repository, 'place').mockRejectedValue(new MeetingsError('BUSY', 'Busy'));
    const before = facade.meetings();

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: { kind: 'folder', folderId: toFolderId('f1') },
    });
    await flushMicrotasks();

    // Assert
    expect(facade.meetings()).toEqual(before);
  });

  /**
   * Phase 2: all three legacy container-kind targets now route through the
   * unified `facade.placeMeeting`, passing `previousId: null, nextId: null`
   * — the backend resolves that to `Placement::Keep` (container change only,
   * no reorder), matching today's behaviour but as one write instead of two.
   * These spy on `facade.placeMeeting` directly rather than the repository,
   * since the routing decision under test lives in the shell page, not in
   * `MeetingsFacade`/`runPlaceMeeting` (covered separately in
   * `meetings.facade.folders.spec.ts`).
   */
  it('a folder target calls placeMeeting with the target folderId, archived false, and null previous/next', async () => {
    // Arrange
    repository.seed([baseMeeting('m1', { folderId: toFolderId('other') })]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeMeetingSpy = vi.spyOn(facade, 'placeMeeting').mockResolvedValue(undefined);

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: { kind: 'folder', folderId: toFolderId('f1') },
    });
    await flushMicrotasks();

    // Assert
    expect(placeMeetingSpy).toHaveBeenCalledWith(toMeetingId('m1'), toFolderId('f1'), false, null, null);
  });

  it('an uncategorized target calls placeMeeting with a null folderId, archived false, and null previous/next', async () => {
    // Arrange
    repository.seed([baseMeeting('m1', { folderId: toFolderId('f1') })]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeMeetingSpy = vi.spyOn(facade, 'placeMeeting').mockResolvedValue(undefined);

    // Act
    fixture.componentInstance.onMeetingMoveRequested({ id: toMeetingId('m1'), target: { kind: 'uncategorized' } });
    await flushMicrotasks();

    // Assert
    expect(placeMeetingSpy).toHaveBeenCalledWith(toMeetingId('m1'), null, false, null, null);
  });

  it('an archive target calls placeMeeting with archived true, the current folderId preserved, and null previous/next', async () => {
    // Arrange
    repository.seed([baseMeeting('m1', { folderId: toFolderId('f1') })]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeMeetingSpy = vi.spyOn(facade, 'placeMeeting').mockResolvedValue(undefined);

    // Act
    fixture.componentInstance.onMeetingMoveRequested({ id: toMeetingId('m1'), target: { kind: 'archive' } });
    await flushMicrotasks();

    // Assert
    expect(placeMeetingSpy).toHaveBeenCalledWith(toMeetingId('m1'), toFolderId('f1'), true, null, null);
  });
});
