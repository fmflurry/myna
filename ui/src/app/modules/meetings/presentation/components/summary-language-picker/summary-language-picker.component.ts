import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { SummaryLanguage } from '../../../core/models/summary-language.model';

/**
 * Pure presentation: offers the summary output languages fetched from
 * `SummarizerPort.listLanguages()` (never a hardcoded list) and reflects
 * the current selection. Injects nothing — the owning page wires
 * `languageSelected` to `MeetingsFacade.selectSummaryLanguage`.
 */
@Component({
  selector: 'app-summary-language-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './summary-language-picker.component.html',
  styleUrl: './summary-language-picker.component.scss',
})
export class SummaryLanguagePickerComponent {
  readonly languages = input<readonly SummaryLanguage[]>([]);
  readonly selectedLanguage = input.required<string>();
  readonly disabled = input(false);

  readonly languageSelected = output<string>();

  protected onChange(event: Event): void {
    this.languageSelected.emit((event.target as HTMLSelectElement).value);
  }
}
