import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { MeetingsErrorCode } from '../../../core/models/recording-state.model';

/**
 * Human-facing copy per stable error code. Never derived from the raw
 * error message string — the message is backend-authored free text and
 * must not be pattern-matched to decide what the UI shows.
 */
const ERROR_MESSAGES: Readonly<Record<MeetingsErrorCode, string>> = {
  BUSY: 'A recording is already in progress.',
  NOT_RECORDING: 'There is no active recording to stop.',
  NOT_FOUND: 'That meeting could not be found. It may have been deleted.',
  IO: 'A file could not be read or written on disk.',
  STORE: 'The local meeting store is unavailable right now.',
  STT: 'Speech-to-text failed while processing the audio.',
  LLM: 'The summarizer failed to generate a response.',
  AUDIO: 'The microphone could not be accessed.',
  MODELS_MISSING: 'Required local models are missing.',
  PATH: 'The selected file location is invalid.',
  // NOTE(tdd-guide RED prerequisite): CANCELLED is never expected to reach this
  // component — the facade treats it as a silent no-op (never calls setError).
  // Present regardless, since `Record<MeetingsErrorCode, string>` is exhaustive.
  CANCELLED: 'The operation was cancelled.',
  AUDIO_CHUNKS_DROPPED: 'Some audio was dropped during recording; the transcript may be incomplete.',
  UNKNOWN: 'Something went wrong.',
};

/** Shared error surface: a human message plus a retry affordance, keyed off the stable error code. */
@Component({
  selector: 'app-error-state',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './error-state.component.html',
  styleUrl: './error-state.component.scss',
})
export class ErrorStateComponent {
  readonly code = input.required<MeetingsErrorCode>();
  readonly retryClicked = output<void>();

  readonly message = computed(() => ERROR_MESSAGES[this.code()] ?? ERROR_MESSAGES.UNKNOWN);
}
