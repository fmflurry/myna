import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { ImportAudioUseCase } from './import-audio.usecase';

describe('ImportAudioUseCase', () => {
  let useCase: ImportAudioUseCase;
  let audioImport: InMemoryAudioImportFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ImportAudioUseCase,
        InMemoryAudioImportFake,
        { provide: AudioImportPort, useExisting: InMemoryAudioImportFake },
      ],
    });
    useCase = TestBed.inject(ImportAudioUseCase);
    audioImport = TestBed.inject(InMemoryAudioImportFake);
  });

  it('delegates to the audio import port with the given path and title', async () => {
    audioImport.seed({
      id: toMeetingId('m-1'),
      title: 'Weekly sync',
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: true, hasSystemTrack: false,
      droppedAudioChunks: 0,
    });

    const meeting = await useCase.import('/tmp/recording.m4a', 'Weekly sync');

    expect(audioImport.getLastImportedPath()).toBe('/tmp/recording.m4a');
    expect(audioImport.getLastImportedTitle()).toBe('Weekly sync');
    expect(meeting.title).toBe('Weekly sync');
  });

  it('delegates with no title when none is given', async () => {
    await useCase.import('/tmp/recording.m4a');

    expect(audioImport.getLastImportedPath()).toBe('/tmp/recording.m4a');
    expect(audioImport.getLastImportedTitle()).toBeUndefined();
  });

  it('propagates a rejection from the port', async () => {
    audioImport.seedError(new Error('conversion failed'));

    let caught: unknown;
    try {
      await useCase.import('/tmp/bad.mov');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
  });
});
