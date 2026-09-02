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
import { InMemoryUpdatesFake } from '../../../application/testing/in-memory-updates.fake';
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
import { UpdatesPort } from '../../../core/ports/updates.port';
import { flushMicrotasks } from '../../../infrastructure/tauri/testing/tauri-internals.stub';
import { provideMeetings } from '../../../meetings.providers';
import { MeetingsShellPage } from './meetings-shell.page';

/**
 * Companion to `meetings-shell.page.drag.spec.ts` (split out to stay under
 * the 400-line file cap), covering the `'placement'` `MeetingMoveTarget`
 * variant — the row-level target emitted when a row is dropped on another
 * row, or reordered via Alt+Arrow (see `resolveRowDropPlacement` /
 * `resolveKeyboardSwapPlacement` in `reorder-target.util.ts`). It carries a
 * `container: MeetingContainer` (same three kinds as the legacy
 * container-level targets covered in the sibling spec) plus a resolved
 * `previousId`/`nextId` neighbour pair, and — like the container-level
 * targets — must route through `facade.placeMeeting`. These tests spy on
 * `facade.placeMeeting` directly (the routing decision under test lives in
 * the shell page), and mirror the container-derivation rules already proven
 * in the sibling spec: `folder` targets pass that folder id and
 * `archived: false`; `uncategorized` passes `folderId: null` and
 * `archived: false`; `archive` passes `archived: true` while preserving the
 * meeting's CURRENT folder (looked up from `facade.meetings()`, exactly as
 * the container-level archive target does).
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
  { provide: UpdatesPort, useClass: InMemoryUpdatesFake },
];

describe('MeetingsShellPage — drag and drop placement move handling', () => {
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

  it('placement into a folder calls placeMeeting with that folder, unarchived, and both neighbours', async () => {
    // Arrange
    repository.seed([baseMeeting('m1'), baseMeeting('m2'), baseMeeting('m3')]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeMeetingSpy = vi.spyOn(facade, 'placeMeeting').mockResolvedValue(undefined);

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: {
        kind: 'placement',
        container: { kind: 'folder', folderId: toFolderId('f1') },
        previousId: toMeetingId('m2'),
        nextId: toMeetingId('m3'),
      },
    });
    await flushMicrotasks();

    // Assert
    expect(placeMeetingSpy).toHaveBeenCalledWith(
      toMeetingId('m1'),
      toFolderId('f1'),
      false,
      toMeetingId('m2'),
      toMeetingId('m3'),
    );
  });

  it('placement into uncategorized calls placeMeeting with a null folder', async () => {
    // Arrange
    repository.seed([baseMeeting('m1', { folderId: toFolderId('f1') }), baseMeeting('m2')]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeMeetingSpy = vi.spyOn(facade, 'placeMeeting').mockResolvedValue(undefined);

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: {
        kind: 'placement',
        container: { kind: 'uncategorized' },
        previousId: toMeetingId('m2'),
        nextId: null,
      },
    });
    await flushMicrotasks();

    // Assert
    expect(placeMeetingSpy).toHaveBeenCalledWith(toMeetingId('m1'), null, false, toMeetingId('m2'), null);
  });

  it("placement into archive calls placeMeeting with archived true and the meeting's existing folder preserved", async () => {
    // Arrange
    repository.seed([baseMeeting('m1', { folderId: toFolderId('f1') })]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeMeetingSpy = vi.spyOn(facade, 'placeMeeting').mockResolvedValue(undefined);

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: {
        kind: 'placement',
        container: { kind: 'archive' },
        previousId: null,
        nextId: null,
      },
    });
    await flushMicrotasks();

    // Assert
    expect(placeMeetingSpy).toHaveBeenCalledWith(toMeetingId('m1'), toFolderId('f1'), true, null, null);
  });

  it('placement with a null previousId (dropped at the top) passes null through', async () => {
    // Arrange
    repository.seed([baseMeeting('m1'), baseMeeting('m2')]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeMeetingSpy = vi.spyOn(facade, 'placeMeeting').mockResolvedValue(undefined);

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: {
        kind: 'placement',
        container: { kind: 'folder', folderId: toFolderId('f1') },
        previousId: null,
        nextId: toMeetingId('m2'),
      },
    });
    await flushMicrotasks();

    // Assert
    expect(placeMeetingSpy).toHaveBeenCalledWith(toMeetingId('m1'), toFolderId('f1'), false, null, toMeetingId('m2'));
  });

  it('placement with a null nextId (dropped at the bottom) passes null through', async () => {
    // Arrange
    repository.seed([baseMeeting('m1'), baseMeeting('m2')]);
    const fixture = createFixture();
    await flushMicrotasks();
    const placeMeetingSpy = vi.spyOn(facade, 'placeMeeting').mockResolvedValue(undefined);

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: {
        kind: 'placement',
        container: { kind: 'folder', folderId: toFolderId('f1') },
        previousId: toMeetingId('m2'),
        nextId: null,
      },
    });
    await flushMicrotasks();

    // Assert
    expect(placeMeetingSpy).toHaveBeenCalledWith(toMeetingId('m1'), toFolderId('f1'), false, toMeetingId('m2'), null);
  });

  it('a rejected placeMeeting leaves the meetings list unchanged', async () => {
    // Arrange
    repository.seed([baseMeeting('m1'), baseMeeting('m2')]);
    const fixture = createFixture();
    await flushMicrotasks();
    vi.spyOn(repository, 'place').mockRejectedValue(new MeetingsError('BUSY', 'Busy'));
    const before = facade.meetings();

    // Act
    fixture.componentInstance.onMeetingMoveRequested({
      id: toMeetingId('m1'),
      target: {
        kind: 'placement',
        container: { kind: 'folder', folderId: toFolderId('f1') },
        previousId: null,
        nextId: toMeetingId('m2'),
      },
    });
    await flushMicrotasks();

    // Assert
    expect(facade.meetings()).toEqual(before);
  });
});
