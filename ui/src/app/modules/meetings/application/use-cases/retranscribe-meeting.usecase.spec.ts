import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { RetranscribeMeetingUseCase } from './retranscribe-meeting.usecase';

describe('RetranscribeMeetingUseCase', () => {
  let useCase: RetranscribeMeetingUseCase;
  let audioImport: InMemoryAudioImportFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        RetranscribeMeetingUseCase,
        InMemoryAudioImportFake,
        { provide: AudioImportPort, useExisting: InMemoryAudioImportFake },
      ],
    });
    useCase = TestBed.inject(RetranscribeMeetingUseCase);
    audioImport = TestBed.inject(InMemoryAudioImportFake);
  });

  it('delegates to the audio import port with the given id and path', async () => {
    const id = toMeetingId('m-1');

    await useCase.retranscribe(id, '/tmp/other.wav');

    expect(audioImport.getLastRetranscribedId()).toBe(id);
    expect(audioImport.getLastRetranscribedPath()).toBe('/tmp/other.wav');
  });

  it('delegates with no path when none is given', async () => {
    const id = toMeetingId('m-1');

    await useCase.retranscribe(id);

    expect(audioImport.getLastRetranscribedId()).toBe(id);
    expect(audioImport.getLastRetranscribedPath()).toBeUndefined();
  });

  it('propagates a rejection from the port', async () => {
    audioImport.seedError(new Error('missing audio file'));

    let caught: unknown;
    try {
      await useCase.retranscribe(toMeetingId('m-1'));
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
  });
});
