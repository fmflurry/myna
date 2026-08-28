import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

/**
 * Empty-state content for the detail pane when no meeting is selected and
 * the models are ready (see `MeetingDetailPaneComponent`, which renders
 * `app-onboarding-panel` instead whenever `modelsReady()` is false). Purely
 * presentational: the owning page wires `startRecordingRequested` to the
 * same `facade.startRecording` call the header Record button already uses.
 */
@Component({
  selector: 'app-welcome-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './welcome-panel.component.html',
  styleUrl: './welcome-panel.component.scss',
})
export class WelcomePanelComponent {
  readonly startingRecording = input(false);

  readonly startRecordingRequested = output<void>();
}
