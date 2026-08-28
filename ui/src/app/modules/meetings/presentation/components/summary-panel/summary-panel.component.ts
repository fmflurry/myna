import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/** Streams the summary markdown; shows a cancel affordance while generating. */
@Component({
  selector: 'app-summary-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './summary-panel.component.html',
  styleUrl: './summary-panel.component.scss',
})
export class SummaryPanelComponent {
  readonly markdown = input.required<string>();
  readonly generating = input(false);
  /** True while a persisted summary's content is being fetched via `get_summary` — distinct from `generating`. */
  readonly loading = input(false);

  readonly cancelClicked = output<void>();
}
