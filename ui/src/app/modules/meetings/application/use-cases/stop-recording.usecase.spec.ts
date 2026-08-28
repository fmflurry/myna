import { TestBed } from '@angular/core/testing';

import { MeetingsError } from '../../core/models/recording-state.model';
import { RecorderPort } from '../../core/ports/recorder.port';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { StopRecordingUseCase } from './stop-recording.usecase';

describe('StopRecordingUseCase', () => {
  let useCase: StopRecordingUseCase;
  let recorder: InMemoryRecorderFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        StopRecordingUseCase,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
      ],
    });
    useCase = TestBed.inject(StopRecordingUseCase);
    recorder = TestBed.inject(InMemoryRecorderFake);
  });

  it('stops an in-progress recording and returns the finished meeting', async () => {
    await recorder.start('Design review');

    const meeting = await useCase.stop();

    expect(meeting.title).toBe('Design review');
    expect(await recorder.state()).toBe('idle');
  });

  it('returns a NotRecording error when no recording is in progress', async () => {
    let caught: unknown;
    try {
      await useCase.stop();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MeetingsError);
    expect((caught as MeetingsError).code).toBe('NOT_RECORDING');
  });
});
