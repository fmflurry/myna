import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { UpdateCheck, UpdateConsent } from '../../../core/models/update.model';

interface LicenceEntry {
  readonly name: string;
  readonly licence: string;
  readonly note: string;
}

/** Fixed licence obligations for the third-party models and runtimes Myna embeds. */
const LICENCE_ENTRIES: readonly LicenceEntry[] = [
  {
    name: 'Parakeet-TDT weights',
    licence: 'CC-BY-4.0',
    note: 'Attribution required — see NVIDIA NeMo Parakeet-TDT model card.',
  },
  {
    name: 'sherpa-onnx',
    licence: 'Apache-2.0',
    note: 'Speech-to-text runtime.',
  },
  {
    name: 'llama.cpp',
    licence: 'MIT',
    note: 'Embedded in-process LLM runtime for Qwen summarization.',
  },
  {
    name: 'Poppins & Inter',
    licence: 'SIL Open Font License 1.1',
    note: 'Brand and product UI typefaces, self-hosted — no external font requests.',
  },
  {
    name: 'Myna',
    licence: 'MIT',
    note: 'This application.',
  },
];

/** Licence-obligation surface — not decoration. Reachable from an About entry point. */
@Component({
  selector: 'app-attribution',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './attribution.component.html',
  styleUrl: './attribution.component.scss',
})
export class AttributionComponent {
  /** Sourced from `app_version()` via `MeetingsFacade.appVersion` — never hardcoded here. */
  readonly version = input<string | undefined>(undefined);

  readonly closed = output<void>();

  /** Sourced from `meetingsFacade.updates.consent()` — required: the shell always has a resolved consent value by the time About can render. */
  readonly updateConsent = input.required<UpdateConsent>();
  readonly lastCheck = input<UpdateCheck | undefined>(undefined);
  readonly checking = input(false);
  /** True while a recording is in progress; disables "Check now" so a manual check never competes with STT for resources. */
  readonly recording = input(false);

  readonly updateConsentChanged = output<UpdateConsent>();
  readonly checkNowRequested = output<void>();

  readonly entries = LICENCE_ENTRIES;

  protected readonly autoCheckEnabled = computed(() => this.updateConsent() === 'granted');
  protected readonly checkNowDisabled = computed(() => this.checking() || this.recording());
  /** Session-only: no timestamp exists in `UpdateCheck`, so this never claims a precise elapsed time — just whether a check has run since launch. */
  protected readonly lastCheckedLabel = computed(() => (this.lastCheck() === undefined ? 'Never' : 'Just now'));

  onAutoCheckToggled(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.updateConsentChanged.emit(checked ? 'granted' : 'declined');
  }

  checkNow(): void {
    this.checkNowRequested.emit();
  }
}
