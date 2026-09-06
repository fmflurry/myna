import { ChangeDetectionStrategy, Component } from '@angular/core';

import { MeetingsFacade } from '../modules/meetings/application/facades/meetings.facade';
import { CaptureSourcePickerComponent } from '../modules/meetings/presentation/components/capture-source-picker/capture-source-picker.component';
import { LiveTranscriptComponent } from '../modules/meetings/presentation/components/live-transcript/live-transcript.component';
import { MeetingSidebarComponent } from '../modules/meetings/presentation/components/meeting-sidebar/meeting-sidebar.component';
import { RecordControlComponent } from '../modules/meetings/presentation/components/record-control/record-control.component';
import { SummaryPanelComponent } from '../modules/meetings/presentation/components/summary-panel/summary-panel.component';
import { MeetingsShellPage } from '../modules/meetings/presentation/pages/meetings-shell/meetings-shell.page';
import { buildScreenshotFacade } from './screenshot-facade.stub';
import {
  makeScreenshotAudioSources,
  makeScreenshotDevices,
  makeScreenshotLiveFinals,
  makeScreenshotMeetings,
  makeScreenshotTemplates,
  readScreenshotScene,
  SCREENSHOT_KEY_POINTS_MARKDOWN,
  type ScreenshotScene,
} from './screenshot-fixtures';

/**
 * Dev-only screenshot host for `?screenshot=<scene>` (see
 * `scripts/capture-screenshots.sh`). Lazy-loaded behind `screenshotCanMatch`,
 * so production never loads this chunk.
 *
 * Library / transcription / hero render the REAL `MeetingsShellPage` against
 * a seeded facade stub (real shell chrome, zero Tauri IPC). Recording and
 * summaries compose the real dumb components directly: the capture-settings
 * popover and the detail-pane tab strip are interaction-driven (closed /
 * transcript-first by default), so those scenes show the same controls
 * openly instead of faking clicks.
 */
@Component({
  selector: 'app-screenshot-host',
  imports: [
    MeetingsShellPage,
    MeetingSidebarComponent,
    RecordControlComponent,
    CaptureSourcePickerComponent,
    LiveTranscriptComponent,
    SummaryPanelComponent,
  ],
  providers: [{ provide: MeetingsFacade, useFactory: () => buildScreenshotFacade(readScreenshotScene()) }],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './screenshot-host.component.html',
})
export class ScreenshotHostComponent {
  protected readonly scene: ScreenshotScene = readScreenshotScene();

  protected readonly sidebarMeetings = makeScreenshotMeetings();
  protected readonly templates = makeScreenshotTemplates();
  protected readonly devices = makeScreenshotDevices();
  protected readonly audioSources = makeScreenshotAudioSources();
  protected readonly liveFinals = makeScreenshotLiveFinals();
  protected readonly keyPointsMarkdown = SCREENSHOT_KEY_POINTS_MARKDOWN;

  protected readonly selectedId = this.sidebarMeetings[0]?.id;
  protected readonly heroHeading = 'Weekly Standup — 28 Aug 2026';
  protected readonly summaryTabs = this.templates.map((template) => ({
    name: template.name,
    label: `${template.emoji ?? ''} ${template.label ?? template.name}`.trim(),
    active: template.name === 'key-points',
  }));
}
