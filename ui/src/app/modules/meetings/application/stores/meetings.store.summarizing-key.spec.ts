import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import { MeetingsStore } from './meetings.store';

const MEETING_ID = toMeetingId('m-1');

/**
 * Regression coverage for "every summary tab shows the same loader while
 * one generates" (see the task brief). `summarizingKey` — a (template,
 * language) identity, not a bare boolean — is what lets the UI scope the
 * generating state to exactly one tab, and the token stream is defensively
 * filtered against it so a stray/late token from a just-finished or
 * just-cancelled generation can never leak into a fresh one. Split into its
 * own file to keep `meetings.store.spec.ts` under the project's max-lines
 * limit (same pattern already used for the meetings-shell page splits).
 */
describe('MeetingsStore summarizingKey', () => {
  let store: MeetingsStore;
  let summarizer: InMemorySummarizerFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        InMemorySummarizerFake,
        { provide: SummarizerPort, useExisting: InMemorySummarizerFake },
        { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
    store = TestBed.inject(MeetingsStore);
    summarizer = TestBed.inject(InMemorySummarizerFake);
  });

  it('setSummarizingKey records the (template, language) pair and derives summarizing=true', () => {
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });

    expect(store.summarizingKey()).toEqual({ template: 'meeting-notes', language: 'en' });
    expect(store.summarizing()).toBe(true);
  });

  it('setSummarizingKey(null) clears the key and derives summarizing=false', () => {
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });

    store.setSummarizingKey(null);

    expect(store.summarizingKey()).toBeNull();
    expect(store.summarizing()).toBe(false);
  });

  it('treats a different language for the same template as a different identity', () => {
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });

    expect(store.summarizingKey()).not.toEqual({ template: 'meeting-notes', language: 'fr' });
  });

  it('appends a token onto summaryStream when its template matches the active summarizingKey', () => {
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });

    summarizer.emitToken({ meetingId: MEETING_ID, template: 'meeting-notes', token: 'Hello' });

    expect(store.summaryStream()).toBe('Hello');
  });

  it('drops a stray token whose template does not match the active summarizingKey', () => {
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });

    summarizer.emitToken({ meetingId: MEETING_ID, template: 'decisions', token: 'Leaked' });

    expect(store.summaryStream()).toBe('');
  });

  it('drops any token once summarizingKey has been cleared', () => {
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });
    store.setSummarizingKey(null);

    summarizer.emitToken({ meetingId: MEETING_ID, template: 'meeting-notes', token: 'Late arrival' });

    expect(store.summaryStream()).toBe('');
  });

  it('regenerate re-setting the same key keeps filtering tokens by template', () => {
    store.resetSummaryStream();
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });
    summarizer.emitToken({ meetingId: MEETING_ID, template: 'meeting-notes', token: 'Fresh ' });

    // Regenerate captures the same pair again — the stream restarts, the filter still holds.
    store.resetSummaryStream();
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });
    summarizer.emitToken({ meetingId: MEETING_ID, template: 'decisions', token: 'Leaked' });
    summarizer.emitToken({ meetingId: MEETING_ID, template: 'meeting-notes', token: 'Take two' });

    expect(store.summaryStream()).toBe('Take two');
    expect(store.summarizing()).toBe(true);
  });

  it('cancel during a regenerate (key cleared) drops late tokens', () => {
    store.resetSummaryStream();
    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });
    store.setSummarizingKey(null);

    summarizer.emitToken({ meetingId: MEETING_ID, template: 'meeting-notes', token: 'Late arrival' });

    expect(store.summaryStream()).toBe('');
    expect(store.summarizing()).toBe(false);
  });
});
