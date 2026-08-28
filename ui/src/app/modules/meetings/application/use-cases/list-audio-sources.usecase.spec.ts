import { TestBed } from '@angular/core/testing';

import { ALL_SYSTEM_AUDIO_SOURCE_ID } from '../../core/models/audio-source.model';
import { RecorderPort } from '../../core/ports/recorder.port';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { ListAudioSourcesUseCase } from './list-audio-sources.usecase';

describe('ListAudioSourcesUseCase', () => {
  let useCase: ListAudioSourcesUseCase;
  let recorder: InMemoryRecorderFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ListAudioSourcesUseCase,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
      ],
    });
    useCase = TestBed.inject(ListAudioSourcesUseCase);
    recorder = TestBed.inject(InMemoryRecorderFake);
  });

  it('returns the sources from the recorder port, always led by the all-output source', async () => {
    const sources = await useCase.list();

    expect(sources[0]).toEqual({ id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' });
    expect(sources.length).toBeGreaterThan(1);
  });

  it('reflects whatever the port returns, never a hardcoded list', async () => {
    recorder.setAudioSources([{ id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' }]);

    const sources = await useCase.list();

    expect(sources).toEqual([{ id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' }]);
  });
});
