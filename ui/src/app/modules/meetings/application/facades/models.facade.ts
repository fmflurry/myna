import { Injectable, OnDestroy, inject } from '@angular/core';
import type { Subscription } from 'rxjs';

import { CheckModelsUseCase } from '../use-cases/check-models.usecase';
import { InitializeModelsUseCase } from '../use-cases/initialize-models.usecase';
import { MeetingsStore } from '../stores/meetings.store';
import { toErrorInfo } from './meetings-facade.support';
import {
  runCancelModelDownload,
  runInitializeDiarizationModels,
  runInitializeModels,
  subscribeToModelDownloadEvents,
} from './meetings-facade-models.support';

/**
 * In-app model-download orchestration, split out of `MeetingsFacade` to stay
 * under the project's max-lines limit. The constructor subscribes to the
 * `models://progress` / `models://done` event streams immediately (NOT in
 * `ngOnInit`, NOT lazily) so specs that install the IPC stub before
 * `TestBed.inject(...)` never miss an event — see
 * `meetings.facade.model-init.spec.ts`. Injected directly by
 * `MeetingsFacade`, never by a component — see the module's facade-pattern
 * rule.
 */
@Injectable()
export class ModelsFacade implements OnDestroy {
  private readonly store = inject(MeetingsStore);
  private readonly initializeModelsUseCase = inject(InitializeModelsUseCase);
  private readonly checkModelsUseCase = inject(CheckModelsUseCase);
  private readonly modelDownloadEvents: Subscription;

  readonly modelDownload = this.store.modelDownload;

  constructor() {
    this.modelDownloadEvents = subscribeToModelDownloadEvents(this.store, this.initializeModelsUseCase, () =>
      this.checkModels(),
    );
  }

  ngOnDestroy(): void {
    this.modelDownloadEvents.unsubscribe();
  }

  async initializeModels(): Promise<void> {
    await runInitializeModels(this.store, this.initializeModelsUseCase);
  }

  async initializeDiarizationModels(): Promise<void> {
    await runInitializeDiarizationModels(this.store, this.initializeModelsUseCase);
  }

  async cancelModelDownload(): Promise<void> {
    await runCancelModelDownload(this.store, this.initializeModelsUseCase);
  }

  private async checkModels(): Promise<void> {
    try {
      this.store.setModelsStatus(await this.checkModelsUseCase.check());
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
    }
  }
}
