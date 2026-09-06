import type { AudioDevice } from '../modules/meetings/core/models/audio-device.model';
import type { AudioSource } from '../modules/meetings/core/models/audio-source.model';
import type { Meeting } from '../modules/meetings/core/models/meeting.model';
import { toMeetingId } from '../modules/meetings/core/models/meeting.model';
import type { ModelsStatus } from '../modules/meetings/core/models/models-status.model';
import type { Summary } from '../modules/meetings/core/models/summary.model';
import type { SummaryLanguage } from '../modules/meetings/core/models/summary-language.model';
import type { SummaryTemplate } from '../modules/meetings/core/models/summary-template.model';
import type { TranscriptSegment } from '../modules/meetings/core/models/transcript.model';

/**
 * Dev-only screenshot harness fixtures (`ui/src/app/screenshot/`).
 *
 * Seeded mock states for `scripts/capture-screenshots.sh`, which captures
 * `http://localhost:<port>/?screenshot=<scene>` with no Tauri backend, no
 * models, and no microphone. Pure data — no Angular, no IPC, no `vi.mock()`.
 *
 * Content rules (mirroring production invariants):
 * - Transcripts use real `Me`/`Others` speaker labels only.
 * - Template names are the four built-ins (`Key Points`, `Action Items`,
 *   `Meeting Notes`, `Decisions`) — never invented summary types.
 * - Never fabricates speaker counts or detected languages.
 */

export type ScreenshotScene = 'library' | 'recording' | 'transcription' | 'summaries' | 'hero';

const SCENE_VALUES: readonly ScreenshotScene[] = ['library', 'recording', 'transcription', 'summaries', 'hero'];

const isScreenshotScene = (value: string | null): value is ScreenshotScene =>
  value !== null && (SCENE_VALUES as readonly string[]).includes(value);

/**
 * Reads the `?screenshot=<scene>` query param (the URL contract owned by
 * `scripts/capture-screenshots.sh`). Falls back to `'library'` so an unknown
 * value still renders seeded, non-blank content instead of an empty page.
 */
export function readScreenshotScene(): ScreenshotScene {
  if (typeof window === 'undefined') {
    return 'library';
  }
  const raw = new URLSearchParams(window.location.search).get('screenshot');
  return isScreenshotScene(raw) ? raw : 'library';
}

/** The four built-in summary templates only — the same names the backend lists. */
export function makeScreenshotTemplates(): readonly SummaryTemplate[] {
  return [
    { name: 'meeting-notes', description: 'Structured notes from the meeting.', prompt: 'Write meeting notes.', label: 'Notes', emoji: '📝' },
    { name: 'key-points', description: 'The key points of the meeting.', prompt: 'List the key points.', label: 'Key Points', emoji: '💡' },
    { name: 'decisions', description: 'Decisions made in the meeting.', prompt: 'List the decisions.', label: 'Decisions', emoji: '✅' },
    { name: 'action-items', description: 'Action items from the meeting.', prompt: 'List the action items.', label: 'Action Items', emoji: '☑️' },
  ];
}

const segment = (
  startSec: number,
  endSec: number,
  speaker: string,
  text: string,
): TranscriptSegment => ({ startSec, endSec, speaker, text });

/** Seeded standup transcript with `Me`/`Others` attribution (plus one named guest). */
export function makeStandupTranscriptSegments(): readonly TranscriptSegment[] {
  return [
    segment(0, 12, 'me', "Let's start with yesterday's progress. I finished the onboarding flow and fixed the playback bug."),
    segment(12, 25, 'others', 'Nice. I wrapped up the transcript export and started on the summary templates.'),
    segment(25, 38, 'me', "For today I'll work on the recording indicator and the stop-phase labels."),
    segment(38, 52, 'others:1', "I'll pick up the sidebar drag-and-drop and the folder placement logic."),
    segment(52, 63, 'me', 'One blocker: system audio capture still needs permission on macOS 14.4 and later.'),
    segment(63, 74, 'others', "Agreed, let's document the fallback to microphone-only in that case."),
  ];
}

/** Shorter seeded transcript for the second library entry. */
export function makeReviewTranscriptSegments(): readonly TranscriptSegment[] {
  return [
    segment(0, 15, 'me', 'The new split workspace looks good. Transcript on the left, summary on the right.'),
    segment(15, 31, 'others', 'I agree. The regenerate flow with instructions is much clearer now.'),
    segment(31, 47, 'me', "Let's ship the sidebar folders next, then revisit speaker detection."),
    segment(47, 60, 'others', 'Sounds like a plan. I will update the usage docs as well.'),
  ];
}

export const SCREENSHOT_KEY_POINTS_MARKDOWN = `## Key Points — Weekly Standup

- Onboarding flow finished; playback bug fixed.
- Transcript export done; summary templates in progress.
- Today: recording indicator, stop-phase labels, sidebar drag-and-drop.
- Blocker: system audio permission on macOS 14.4 and later, falls back to microphone-only.`;

export const SCREENSHOT_MEETING_NOTES_MARKDOWN = `## Meeting Notes — Weekly Standup

The team reviewed yesterday's progress and set today's plan. Recording and transcript work is on track; the only blocker is the macOS system-audio permission, which degrades gracefully to microphone-only.

Next check-in tomorrow at 09:30.`;

export const SCREENSHOT_DECISIONS_MARKDOWN = `## Decisions — Weekly Standup

- Ship sidebar folders before revisiting speaker detection.
- Document the microphone-only fallback for systems without audio permission.
- Keep the split workspace as the default wide layout.`;

export const SCREENSHOT_ACTION_ITEMS_MARKDOWN = `## Action Items — Weekly Standup

- [ ] Recording indicator and stop-phase labels (@me)
- [ ] Sidebar drag-and-drop and folder placement (@others)
- [ ] Usage docs update (@others)`;

const summary = (template: string, markdown: string): Summary => ({
  template,
  markdown,
  createdAt: new Date('2026-08-28T10:15:00'),
  language: 'en',
  stale: false,
});

/** Three seeded meetings: rich (transcript + summaries), transcript-only, and empty. */
export function makeScreenshotMeetings(): readonly Meeting[] {
  return [
    {
      id: toMeetingId('shot-weekly-standup'),
      title: 'Weekly Standup',
      createdAt: new Date('2026-08-28T09:30:00'),
      durationSec: 1540,
      transcript: { segments: makeStandupTranscriptSegments() },
      summaries: [
        summary('meeting-notes', SCREENSHOT_MEETING_NOTES_MARKDOWN),
        summary('key-points', SCREENSHOT_KEY_POINTS_MARKDOWN),
      ],
      archived: false,
      hasAudio: false,
      hasSystemTrack: false,
      droppedAudioChunks: 0,
      speakerNames: { 'others:1': 'Priya' },
    },
    {
      id: toMeetingId('shot-product-review'),
      title: 'Product Review',
      createdAt: new Date('2026-08-27T14:00:00'),
      durationSec: 2740,
      transcript: { segments: makeReviewTranscriptSegments() },
      summaries: [],
      archived: false,
      hasAudio: false,
      hasSystemTrack: false,
      droppedAudioChunks: 0,
    },
    {
      id: toMeetingId('shot-design-critique'),
      title: 'Design Critique',
      createdAt: new Date('2026-08-26T11:00:00'),
      durationSec: 890,
      summaries: [],
      archived: false,
      hasAudio: false,
      hasSystemTrack: false,
      droppedAudioChunks: 0,
    },
  ];
}

export function makeScreenshotDevices(): readonly AudioDevice[] {
  return [{ name: 'Built-in Microphone' }, { name: 'USB Headset' }];
}

export function makeScreenshotAudioSources(): readonly AudioSource[] {
  return [
    { id: 'system:all', name: 'All system output' },
    { id: 'app:teams', name: 'Teams' },
  ];
}

export function makeScreenshotModelsStatus(): ModelsStatus {
  const slot = (present: boolean): ModelsStatus['parakeet'] => ({ present, expectedFiles: [] });
  return { parakeet: slot(true), qwen: slot(true), silero: slot(true), diarization: slot(true), allPresent: true };
}

export function makeScreenshotSummaryLanguages(): readonly SummaryLanguage[] {
  return [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'Français' },
  ];
}

/** Seeded live-recording finals for the recording scene's live transcript. */
export function makeScreenshotLiveFinals(): readonly TranscriptSegment[] {
  return [
    segment(754, 762, 'me', 'Welcome back, everyone. Recording is live with both microphone and system audio.'),
    segment(762, 771, 'others', 'Audio looks good on my side. Sharing the agenda now.'),
    segment(771, 782, 'me', 'First item: the release checklist. Docs first, then the packaged build.'),
  ];
}
