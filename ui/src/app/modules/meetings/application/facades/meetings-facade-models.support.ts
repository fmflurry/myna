import { Subscription, defer, retry, timer } from 'rxjs';

import { IDLE_MODEL_DOWNLOAD, type MeetingsStore, type ModelDownloadState } from '../stores/meetings.store';
import type { InitializeModelsUseCase } from '../use-cases/initialize-models.usecase';
import { toErrorInfo } from './meetings-facade.support';

/** Number of retry attempts for the `models://progress` / `models://done` event streams before giving up. Mirrors the import-event discipline. */
export const MODEL_EVENTS_RETRY_COUNT = 5;

/** Delay, in milliseconds, between retry attempts for the model event streams. */
export const MODEL_EVENTS_RETRY_DELAY_MS = 1000;

/**
 * Starts the in-app model download. The store slice flips to `'running'`
 * immediately so the onboarding panel shows the step list at once; the
 * `start()` promise resolves as soon as the backend spawns the run (or
 * no-ops when everything is already present) — per-artifact progress and
 * the terminal outcome arrive via {@link subscribeToModelDownloadEvents}.
 * A rejected `start()` (e.g. `BUSY` because a run is already in flight)
 * lands the slice in `'failed'` so the panel never sits on a phantom
 * running state.
 */
export async function runInitializeModels(store: MeetingsStore, initializeModelsUseCase: InitializeModelsUseCase): Promise<void> {
  store.setModelDownload({ ...IDLE_MODEL_DOWNLOAD, phase: 'running' });
  try {
    await initializeModelsUseCase.start();
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
    store.setModelDownload({ ...IDLE_MODEL_DOWNLOAD, phase: 'failed', message: toErrorInfo(caught).message });
  }
}

/**
 * Starts the diarization-only in-app download. Reuses the same
 * `models://progress` / `models://done` subscription as the core path —
 * see `subscribeToModelDownloadEvents` — so a single `diarization` step
 * (1/1) shows inline in the detail pane and the terminal `checkModels`
 * refresh enables Detect speakers.
 */
export async function runInitializeDiarizationModels(
  store: MeetingsStore,
  initializeModelsUseCase: InitializeModelsUseCase,
): Promise<void> {
  store.setModelDownload({ ...IDLE_MODEL_DOWNLOAD, phase: 'running' });
  try {
    await initializeModelsUseCase.startDiarization();
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
    store.setModelDownload({ ...IDLE_MODEL_DOWNLOAD, phase: 'failed', message: toErrorInfo(caught).message });
  }
}

/**
 * Cancels the in-flight model download. The backend kills the current
 * child and emits a cancelled `models://done`, which
 * {@link subscribeToModelDownloadEvents} lands as phase `'failed'` with
 * `cancelled: true` — this function only forwards the command and any
 * rejection to the error slot.
 */
export async function runCancelModelDownload(store: MeetingsStore, initializeModelsUseCase: InitializeModelsUseCase): Promise<void> {
  try {
    await initializeModelsUseCase.cancel();
    store.clearError();
  } catch (caught) {
    store.setError(toErrorInfo(caught));
  }
}

/**
 * Subscribes `store` to the model-download event streams with the same
 * log+bounded-retry discipline as the import events (see
 * `subscribeToAudioImportEvents`). A `models://progress` event moves the
 * slice to `'running'` with the artifact about to download; a
 * `models://done` event lands `'done'` (on success, after which
 * `checkModels` refreshes `modelsStatus` so `allPresent` flips and the
 * onboarding panel dismisses itself) or `'failed'` (on failure or
 * cancellation). Returns a {@link Subscription} the facade tears down in
 * `ngOnDestroy`.
 */
export function subscribeToModelDownloadEvents(
  store: MeetingsStore,
  initializeModelsUseCase: InitializeModelsUseCase,
  checkModels: () => Promise<void>,
): Subscription {
  const progressSubscription = defer(() => initializeModelsUseCase.progress())
    .pipe(
      retry({
        count: MODEL_EVENTS_RETRY_COUNT,
        delay: (error) => {
          console.error('[modelDownload] progress stream failed', error);
          return timer(MODEL_EVENTS_RETRY_DELAY_MS);
        },
      }),
    )
    .subscribe(
      (progress) => {
        store.setModelDownload({
          phase: 'running',
          artifact: progress.artifact,
          index: progress.index,
          total: progress.total,
          success: false,
          cancelled: false,
          message: null,
        });
      },
      (error) => {
        // Terminal after `MODEL_EVENTS_RETRY_COUNT` failed attempts: log and
        // keep the last known state rather than letting RxJS surface an
        // unhandled error (the events are best-effort; `models_status`
        // remains the source of truth).
        console.error('[modelDownload] progress stream gave up', error);
      },
    );

  const doneSubscription = defer(() => initializeModelsUseCase.done())
    .pipe(
      retry({
        count: MODEL_EVENTS_RETRY_COUNT,
        delay: (error) => {
          console.error('[modelDownload] done stream failed', error);
          return timer(MODEL_EVENTS_RETRY_DELAY_MS);
        },
      }),
    )
    .subscribe(
      (done) => {
        const state: ModelDownloadState = done.success
          ? { ...IDLE_MODEL_DOWNLOAD, phase: 'done', success: true }
          : { ...IDLE_MODEL_DOWNLOAD, phase: 'failed', cancelled: done.cancelled, message: done.message };
        store.setModelDownload(state);
        if (done.success) {
          void checkModels();
        }
      },
      (error) => {
        console.error('[modelDownload] done stream gave up', error);
      },
    );

  return new Subscription(() => {
    progressSubscription.unsubscribe();
    doneSubscription.unsubscribe();
  });
}
