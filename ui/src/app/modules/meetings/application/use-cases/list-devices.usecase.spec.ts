import { TestBed } from '@angular/core/testing';

import { RecorderPort } from '../../core/ports/recorder.port';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { ListDevicesUseCase } from './list-devices.usecase';

describe('ListDevicesUseCase', () => {
  let useCase: ListDevicesUseCase;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ListDevicesUseCase,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
      ],
    });
    useCase = TestBed.inject(ListDevicesUseCase);
  });

  it('returns the available input devices', async () => {
    const devices = await useCase.list();

    expect(devices.length).toBeGreaterThan(0);
  });

  it('returns the default input device', async () => {
    const device = await useCase.default();

    expect(device.name).toBe('Built-in Microphone');
  });
});
