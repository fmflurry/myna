import { TestBed } from '@angular/core/testing';

import { MeetingsError } from '../../core/models/recording-state.model';
import { RecorderPort } from '../../core/ports/recorder.port';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { StartRecordingUseCase } from './start-recording.usecase';

describe('StartRecordingUseCase', () => {
  let useCase: StartRecordingUseCase;
  let recorder: InMemoryRecorderFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        StartRecordingUseCase,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
      ],
    });
    useCase = TestBed.inject(StartRecordingUseCase);
    recorder = TestBed.inject(InMemoryRecorderFake);
  });

  it('starts a new recording when idle', async () => {
    const meeting = await useCase.with('Weekly sync');

    expect(meeting.title).toBe('Weekly sync');
    expect((await recorder.state()).state).toBe('recording');
  });

  it('forwards the requested capture source to the recorder port', async () => {
    await useCase.with('Weekly sync', 'Built-in Microphone', 'mixed');

    expect(recorder.getLastRequestedSource()).toBe('mixed');
  });

  it('returns a Busy error when a recording is already in progress', async () => {
    await useCase.with('First meeting');

    let caught: unknown;
    try {
      await useCase.with('Second meeting');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(MeetingsError);
    expect((caught as MeetingsError).code).toBe('BUSY');
  });
});
