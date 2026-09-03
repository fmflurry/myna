import { TestBed } from '@angular/core/testing';

import { RecorderPort } from '../../core/ports/recorder.port';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { CancelRecordingUseCase } from './cancel-recording.usecase';

describe('CancelRecordingUseCase', () => {
  let useCase: CancelRecordingUseCase;
  let recorder: InMemoryRecorderFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        CancelRecordingUseCase,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
      ],
    });
    useCase = TestBed.inject(CancelRecordingUseCase);
    recorder = TestBed.inject(InMemoryRecorderFake);
  });

  it('cancels an in-progress recording and returns to idle', async () => {
    await recorder.start('Ad-hoc call');

    await useCase.cancel();

    expect((await recorder.state()).state).toBe('idle');
  });

  it('is a no-op when there is nothing to cancel', async () => {
    const result = await useCase.cancel();

    expect(result).toBeUndefined();
    expect((await recorder.state()).state).toBe('idle');
  });
});
