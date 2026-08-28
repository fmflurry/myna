import { TestBed } from '@angular/core/testing';

import { AppInfoPort } from '../../core/ports/app-info.port';
import { InMemoryAppInfoFake } from '../testing/in-memory-app-info.fake';
import { GetAppVersionUseCase } from './get-app-version.usecase';

describe('GetAppVersionUseCase', () => {
  let useCase: GetAppVersionUseCase;
  let appInfo: InMemoryAppInfoFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [GetAppVersionUseCase, { provide: AppInfoPort, useClass: InMemoryAppInfoFake }],
    });
    useCase = TestBed.inject(GetAppVersionUseCase);
    appInfo = TestBed.inject(AppInfoPort) as InMemoryAppInfoFake;
  });

  it('resolves the version reported by AppInfoPort', async () => {
    appInfo.seedVersion('0.4.2');

    const version = await useCase.version();

    expect(version).toBe('0.4.2');
  });
});
