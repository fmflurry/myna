import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { toFolderId } from '../../core/models/folder.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import { AppInfoPort } from '../../core/ports/app-info.port';
import { FileDialogPort } from '../../core/ports/file-dialog.port';
import { FolderRepositoryPort } from '../../core/ports/folder-repository.port';
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
import { InMemoryFolderRepositoryFake } from '../testing/in-memory-folder-repository.fake';
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
 * explicit overrides — mirrors `meetings.facade.spec.ts`.
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

describe('MeetingsFacade folders', () => {
  let facade: MeetingsFacade;
  let folderRepository: InMemoryFolderRepositoryFake;
  let meetingRepository: InMemoryMeetingRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideMeetings(), ...FAKE_PORT_OVERRIDES],
    });
    facade = TestBed.inject(MeetingsFacade);
    folderRepository = TestBed.inject(FolderRepositoryPort) as InMemoryFolderRepositoryFake;
    meetingRepository = TestBed.inject(MeetingRepositoryPort) as InMemoryMeetingRepositoryFake;
  });

  it('starts with an empty folders list', () => {
    // Assert
    expect(facade.folders()).toEqual([]);
  });

  it('createFolder appends to the folders signal', async () => {
    // Act
    await facade.createFolder('Work');

    // Assert
    expect(facade.folders().length).toBe(1);
    expect(facade.folders()[0]?.name).toBe('Work');
    expect(facade.error()).toBeUndefined();
  });

  it('a rejected create leaves folders untouched and sets the error slot', async () => {
    // Arrange
    folderRepository.failNextCreate(new MeetingsError('UNKNOWN', 'disk full'));

    // Act
    await facade.createFolder('Work');

    // Assert
    expect(facade.folders()).toEqual([]);
    expect(facade.error()?.message).toBe('disk full');
  });

  it('setMeetingFolder is non-optimistic — a rejection leaves the meeting folderId unchanged', async () => {
    // Arrange
    const meeting = {
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false,
      hasSystemTrack: false,
      droppedAudioChunks: 0,
    };
    meetingRepository.seed([meeting]);
    await facade.loadMeetings();

    // Act: target a meeting id the repository doesn't know, forcing a NOT_FOUND rejection.
    await facade.setMeetingFolder(toMeetingId('missing'), toFolderId('f-1'));

    // Assert
    expect(facade.meetings()[0]?.folderId).toBeUndefined();
    expect(facade.error()?.code).toBe('NOT_FOUND');
  });

  /** Minimal fixture shared by the `placeMeeting` specs below. */
  const meetingFixture = (id: string) => ({
    id: toMeetingId(id),
    title: `Meeting ${id}`,
    createdAt: new Date(),
    durationSec: 0,
    summaries: [],
    archived: false,
    hasAudio: false,
    hasSystemTrack: false,
    droppedAudioChunks: 0,
  });

  it('placeMeeting makes one mutate call, then reloads meetings', async () => {
    // Arrange
    const meetingA = meetingFixture('a');
    const meetingB = meetingFixture('b');
    meetingRepository.seed([meetingA, meetingB]);
    await facade.loadMeetings();
    const placeSpy = vi.spyOn(meetingRepository, 'place');
    const loadMeetingsSpy = vi.spyOn(facade, 'loadMeetings');

    // Act
    await facade.placeMeeting(meetingA.id, null, false, null, meetingB.id);

    // Assert
    expect(placeSpy).toHaveBeenCalledTimes(1);
    expect(placeSpy).toHaveBeenCalledWith(meetingA.id, null, false, null, meetingB.id);
    expect(loadMeetingsSpy).toHaveBeenCalledTimes(1);
  });

  it('a rejected placeMeeting leaves the meetings list untouched and sets the error slot (non-optimistic)', async () => {
    // Arrange
    const meeting = meetingFixture('m-1');
    meetingRepository.seed([meeting]);
    await facade.loadMeetings();
    const before = facade.meetings();

    // Act: target a meeting id the repository doesn't know, forcing a NOT_FOUND rejection.
    await facade.placeMeeting(toMeetingId('missing'), null, false, null, null);

    // Assert
    expect(facade.meetings()).toEqual(before);
    expect(facade.error()?.code).toBe('NOT_FOUND');
  });

  it('the reorder is visible after the reload — guards the updateMeeting-preserves-order trap', async () => {
    // Arrange
    const meetingA = meetingFixture('a');
    const meetingB = meetingFixture('b');
    meetingRepository.seed([meetingA, meetingB]);
    await facade.loadMeetings();
    expect(facade.meetings().map((meeting) => meeting.id)).toEqual([meetingA.id, meetingB.id]);
    // Simulates the backend's actual reordering: the NEXT list() call (the
    // one `placeMeeting`'s reload triggers) comes back with b before a.
    // `MeetingsStore.updateMeeting` preserves array order, so if
    // `placeMeeting` only mirrored the mutated meeting instead of reloading,
    // this assertion would fail with the order unchanged.
    vi.spyOn(meetingRepository, 'list').mockResolvedValueOnce([meetingB, meetingA]);

    // Act
    await facade.placeMeeting(meetingA.id, null, false, meetingB.id, null);

    // Assert
    expect(facade.meetings().map((meeting) => meeting.id)).toEqual([meetingB.id, meetingA.id]);
  });

  it('deleteFolder refreshes the meetings list', async () => {
    // Arrange
    const meeting = {
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false,
      hasSystemTrack: false,
      droppedAudioChunks: 0,
    };
    meetingRepository.seed([meeting]);
    await facade.createFolder('Work');
    const folder = facade.folders()[0];
    if (!folder) {
      throw new Error('Expected a created folder.');
    }
    const loadMeetingsSpy = vi.spyOn(facade, 'loadMeetings');

    // Act
    await facade.deleteFolder(folder.id);

    // Assert
    expect(loadMeetingsSpy).toHaveBeenCalledTimes(1);
  });
});
