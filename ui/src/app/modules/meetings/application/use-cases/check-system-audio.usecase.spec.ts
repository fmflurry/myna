import { TestBed } from '@angular/core/testing';

import { RecorderPort } from '../../core/ports/recorder.port';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { CheckSystemAudioUseCase } from './check-system-audio.usecase';

describe('CheckSystemAudioUseCase', () => {
  let useCase: CheckSystemAudioUseCase;
  let recorder: InMemoryRecorderFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CheckSystemAudioUseCase,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
      ],
    });
    useCase = TestBed.inject(CheckSystemAudioUseCase);
    recorder = TestBed.inject(InMemoryRecorderFake);
  });

  it('status() reports unknown by default (no preflight API exists for the audio permission)', async () => {
    expect(await useCase.status()).toEqual({ kind: 'unknown' });
  });

  it('status() reflects an available status set on the port', async () => {
    recorder.setSystemAudioStatus({ kind: 'available' });

    expect(await useCase.status()).toEqual({ kind: 'available' });
  });

  it('status() reflects a permission_denied status set on the port', async () => {
    recorder.setSystemAudioStatus({ kind: 'permission_denied', restartRequired: true });

    expect(await useCase.status()).toEqual({ kind: 'permission_denied', restartRequired: true });
  });

  it('request() prompts for permission and returns the resulting status', async () => {
    recorder.setSystemAudioStatus({ kind: 'unavailable', reason: 'No system audio device found.' });

    expect(await useCase.request()).toEqual({
      kind: 'unavailable',
      reason: 'No system audio device found.',
    });
  });
});
