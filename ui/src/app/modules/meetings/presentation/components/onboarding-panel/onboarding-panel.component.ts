import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';

import { IDLE_MODEL_DOWNLOAD, type MeetingsErrorInfo, type ModelDownloadState } from '../../../application/stores/meetings.store';
import type { ModelSlot, ModelsStatus } from '../../../core/models/models-status.model';
import { ErrorStateComponent } from '../error-state/error-state.component';

/**
 * Rotating reassurance lines shown while models download. Deliberately
 * indeterminate — no fake %, MB, or ETA figures, funny tone only.
 */
export const DOWNLOAD_WHIMSY: readonly string[] = [
  'Teaching your Mac to listen…',
  'Unpacking words-in-a-box. No cloud harmed.',
  'Still downloading — big brains take a minute.',
  'Good time to grab a coffee.',
  'Meetings stay on your Mac. Promise.',
  'Almost there — summaries are worth the wait.',
];

/** How long each reassurance line stays up before rotating to the next. */
export const WHIMSY_ROTATE_MS = 30000;

interface ModelGroup {
  readonly label: string;
  readonly slot: ModelSlot;
}

/**
 * Blocking state rendered inside the detail pane whenever
 * `modelsStatus()?.allPresent` is false — never a separate route. Lists every
 * expected model artefact by its real filename, sourced live from
 * `ModelsStatus`, never hardcoded. Copy is deliberately aimed at a
 * non-technical user: no shell commands, paths, or terminal instructions are
 * ever shown. Pure presentation: the owning page wires `recheckRequested` to
 * `facade.checkModels()`.
 */
@Component({
  selector: 'app-onboarding-panel',
  imports: [ErrorStateComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './onboarding-panel.component.html',
  styleUrl: './onboarding-panel.component.scss',
})
export class OnboardingPanelComponent {
  readonly status = input<ModelsStatus | undefined>(undefined);
  readonly error = input<MeetingsErrorInfo | undefined>(undefined);
  readonly modelDownload = input<ModelDownloadState | undefined>(undefined);

  readonly recheckRequested = output<void>();
  readonly downloadRequested = output<void>();
  readonly downloadCancelRequested = output<void>();

  /** {@link modelDownload} normalized to a concrete state — the store's resting value before the first download run of the session. */
  protected readonly download = computed((): ModelDownloadState => this.modelDownload() ?? IDLE_MODEL_DOWNLOAD);
  protected readonly isDownloading = computed(() => this.download().phase === 'running');
  protected readonly downloadFailed = computed(() => this.download().phase === 'failed');

  /** Position in {@link DOWNLOAD_WHIMSY}; advanced by the rotation timer below. */
  protected readonly whimsyIndex = signal(0);
  protected readonly whimsy = computed(
    (): string => DOWNLOAD_WHIMSY[this.whimsyIndex() % DOWNLOAD_WHIMSY.length] ?? '',
  );

  constructor() {
    // 30 s reassurance rotation: runs only while downloading, restarts from
    // the first line on every new run, interval cleared on cleanup.
    effect((onCleanup) => {
      if (!this.isDownloading()) {
        return;
      }
      this.whimsyIndex.set(0);
      const timer = setInterval(() => {
        this.whimsyIndex.update((i) => i + 1);
      }, WHIMSY_ROTATE_MS);
      onCleanup(() => clearInterval(timer));
    });
  }

  protected readonly groups = computed((): readonly ModelGroup[] => {
    const current = this.status();
    if (!current) {
      return [];
    }
    return [
      { label: 'Transcription — turns speech into text', slot: current.parakeet },
      { label: 'Summaries — key points from your meetings', slot: current.qwen },
      { label: 'Voice detection — knows when someone is speaking', slot: current.silero },
    ];
  });

  recheck(): void {
    this.recheckRequested.emit();
  }

  startDownload(): void {
    this.downloadRequested.emit();
  }

  cancelDownload(): void {
    this.downloadCancelRequested.emit();
  }
}
