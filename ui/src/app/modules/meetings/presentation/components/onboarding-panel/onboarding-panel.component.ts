import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import { IDLE_MODEL_DOWNLOAD, type MeetingsErrorInfo, type ModelDownloadState } from '../../../application/stores/meetings.store';
import type { ModelSlot, ModelsStatus } from '../../../core/models/models-status.model';
import { ErrorStateComponent } from '../error-state/error-state.component';

/** Fixed, human-facing invocation for the model download helper script. */
const DOWNLOAD_COMMAND = './scripts/download-models.sh';

interface ModelGroup {
  readonly label: string;
  readonly slot: ModelSlot;
}

/**
 * Blocking state rendered inside the detail pane whenever
 * `modelsStatus()?.allPresent` is false — never a separate route. Lists every
 * expected model artefact by its real filename, sourced live from
 * `ModelsStatus`, never hardcoded. Pure presentation: the owning page wires
 * `recheckRequested` to `facade.checkModels()`.
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

  protected readonly downloadCommand = DOWNLOAD_COMMAND;
  protected readonly copied = signal(false);

  /** {@link modelDownload} normalized to a concrete state — the store's resting value before the first download run of the session. */
  protected readonly download = computed((): ModelDownloadState => this.modelDownload() ?? IDLE_MODEL_DOWNLOAD);
  protected readonly isDownloading = computed(() => this.download().phase === 'running');
  protected readonly downloadFailed = computed(() => this.download().phase === 'failed');

  protected readonly groups = computed((): readonly ModelGroup[] => {
    const current = this.status();
    if (!current) {
      return [];
    }
    return [
      { label: 'Speech-to-text (Parakeet-TDT)', slot: current.parakeet },
      { label: 'Summarization (Qwen2.5)', slot: current.qwen },
      { label: 'Voice activity detection (Silero)', slot: current.silero },
    ];
  });

  recheck(): void {
    this.copied.set(false);
    this.recheckRequested.emit();
  }

  startDownload(): void {
    this.downloadRequested.emit();
  }

  cancelDownload(): void {
    this.downloadCancelRequested.emit();
  }

  async copyDownloadCommand(): Promise<void> {
    await navigator.clipboard.writeText(this.downloadCommand);
    this.copied.set(true);
  }
}
