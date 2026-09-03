import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { SummaryLanguage } from '../../../core/models/summary-language.model';
import type { UpdateCheck, UpdateConsent } from '../../../core/models/update.model';

/**
 * The minimal honest settings surface: only controls whose state is fully
 * wired to the facade render here — update-check consent + manual check
 * (same semantics as About > Updates) and the summary output language.
 * Injects nothing; the shell owns every `MeetingsFacade` call.
 */
@Component({
  selector: 'app-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings.component.html',
  styleUrl: './settings.component.scss',
})
export class SettingsComponent {
  /** Sourced from `meetingsFacade.updates.consent()` — required: the shell always has a resolved consent value by the time Settings can render. */
  readonly updateConsent = input.required<UpdateConsent>();
  readonly lastCheck = input<UpdateCheck | undefined>(undefined);
  readonly checking = input(false);
  /** True while a recording is in progress; disables "Check now" so a manual check never competes with STT for resources. */
  readonly recording = input(false);
  /** The Rust-owned language list (`SummarizerPort.listLanguages()` via the store) — never a second hardcoded copy. */
  readonly summaryLanguages = input<readonly SummaryLanguage[]>([]);
  readonly selectedSummaryLanguage = input.required<string>();

  readonly closed = output<void>();
  readonly updateConsentChanged = output<UpdateConsent>();
  readonly checkNowRequested = output<void>();
  readonly summaryLanguageSelected = output<string>();

  protected readonly autoCheckEnabled = computed(() => this.updateConsent() === 'granted');
  protected readonly checkNowDisabled = computed(() => this.checking() || this.recording());
  /** Session-only: no timestamp exists in `UpdateCheck`, so this never claims a precise elapsed time — just whether a check has run since launch. */
  protected readonly lastCheckedLabel = computed(() => (this.lastCheck() === undefined ? 'Not this session' : 'Just now'));

  onAutoCheckToggled(event: Event): void {
    const checked = (event.target as HTMLInputElement).checked;
    this.updateConsentChanged.emit(checked ? 'granted' : 'declined');
  }

  checkNow(): void {
    this.checkNowRequested.emit();
  }

  onSummaryLanguageChanged(event: Event): void {
    this.summaryLanguageSelected.emit((event.target as HTMLSelectElement).value);
  }
}
