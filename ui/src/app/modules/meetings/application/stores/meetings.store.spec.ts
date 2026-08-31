import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import { ALL_SYSTEM_AUDIO_SOURCE_ID } from '../../core/models/audio-source.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { AudioImportPort } from '../../core/ports/audio-import.port';
import { PreferencesPort } from '../../core/ports/preferences.port';
import { RecorderPort } from '../../core/ports/recorder.port';
import { SummarizerPort } from '../../core/ports/summarizer.port';
import { TranscriberPort } from '../../core/ports/transcriber.port';
import { transcriptSegment } from '../testing/transcript-segment.factory';
import { InMemoryAudioImportFake } from '../testing/in-memory-audio-import.fake';
import { InMemoryPreferencesFake } from '../testing/in-memory-preferences.fake';
import { InMemoryRecorderFake } from '../testing/in-memory-recorder.fake';
import { InMemorySummarizerFake } from '../testing/in-memory-summarizer.fake';
import { InMemoryTranscriberFake } from '../testing/in-memory-transcriber.fake';
import {
  AUDIO_SOURCE_PREFERENCE_KEY,
  CAPTURE_SOURCE_PREFERENCE_KEY,
  MeetingsStore,
  PARTIAL_UI_AUDIT_MS,
  SUMMARY_LANGUAGE_PREFERENCE_KEY,
} from './meetings.store';

const MEETING_ID = toMeetingId('m-1');

describe('MeetingsStore', () => {
  let store: MeetingsStore;
  let recorder: InMemoryRecorderFake;
  let transcriber: InMemoryTranscriberFake;
  let preferences: InMemoryPreferencesFake;
  let audioImport: InMemoryAudioImportFake;

  const configureStore = (sharedPreferences?: InMemoryPreferencesFake) => {
    TestBed.configureTestingModule({
      providers: [
        MeetingsStore,
        InMemoryRecorderFake,
        { provide: RecorderPort, useExisting: InMemoryRecorderFake },
        InMemoryTranscriberFake,
        { provide: TranscriberPort, useExisting: InMemoryTranscriberFake },
        { provide: SummarizerPort, useClass: InMemorySummarizerFake },
        InMemoryAudioImportFake,
        { provide: AudioImportPort, useExisting: InMemoryAudioImportFake },
        sharedPreferences
          ? { provide: PreferencesPort, useValue: sharedPreferences }
          : { provide: PreferencesPort, useClass: InMemoryPreferencesFake },
      ],
    });
  };

  beforeEach(() => {
    configureStore();
    store = TestBed.inject(MeetingsStore);
    recorder = TestBed.inject(InMemoryRecorderFake);
    transcriber = TestBed.inject(InMemoryTranscriberFake);
    preferences = TestBed.inject(PreferencesPort) as InMemoryPreferencesFake;
    audioImport = TestBed.inject(InMemoryAudioImportFake);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts idle and not busy', () => {
    expect(store.recordingState()).toBe('idle');
    expect(store.busy()).toBe(false);
  });

  it('reflects recorder state changes as they stream in', async () => {
    await recorder.start('Weekly sync');

    expect(store.recordingState()).toBe('recording');
    expect(store.busy()).toBe(true);
  });

  it('appends finalized transcript segments onto finalizedSegments', () => {
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 0, endSec: 1, text: 'Hello' }),
    });

    expect(store.finalizedSegments().length).toBe(1);
    expect(store.finalizedSegments()[0]?.text).toBe('Hello');
  });

  it('renders a burst of finals followed by a trailing partial without dropping any of them', () => {
    vi.useFakeTimers();

    for (let index = 0; index < 5; index += 1) {
      transcriber.emitFinal({
        meetingId: toMeetingId('m-1'),
        segment: transcriptSegment({ startSec: index, endSec: index + 1, text: `Sentence ${index}` }),
      });
    }
    transcriber.emitPartial({ meetingId: toMeetingId('m-1'), text: 'still speaking', speaker: 'me' });
    vi.advanceTimersByTime(PARTIAL_UI_AUDIT_MS);

    expect(store.finalizedSegments().length).toBe(5);
    expect(store.finalizedSegments().map((segment) => segment.text)).toEqual([
      'Sentence 0',
      'Sentence 1',
      'Sentence 2',
      'Sentence 3',
      'Sentence 4',
    ]);
    expect(store.partialTextMe()).toBe('still speaking');
  });

  it('replaces the partial with the final once it arrives, keeping the final', () => {
    vi.useFakeTimers();

    transcriber.emitPartial({ meetingId: toMeetingId('m-1'), text: 'partial in flight', speaker: 'me' });
    vi.advanceTimersByTime(PARTIAL_UI_AUDIT_MS);
    expect(store.partialTextMe()).toBe('partial in flight');

    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 0, endSec: 1, text: 'partial in flight, finalized' }),
    });

    expect(store.partialTextMe()).toBe('');
    expect(store.finalizedSegments().length).toBe(1);
    expect(store.finalizedSegments()[0]?.text).toBe('partial in flight, finalized');
  });

  it('throttles a burst of partials to at most one update per audit window, keeping the latest', () => {
    vi.useFakeTimers();

    transcriber.emitPartial({ meetingId: toMeetingId('m-1'), text: 'partial 1', speaker: 'me' });
    transcriber.emitPartial({ meetingId: toMeetingId('m-1'), text: 'partial 2', speaker: 'me' });
    transcriber.emitPartial({ meetingId: toMeetingId('m-1'), text: 'partial 3', speaker: 'me' });

    // Nothing reaches the store yet — the audit window hasn't elapsed.
    expect(store.partialTextMe()).toBe('');

    vi.advanceTimersByTime(PARTIAL_UI_AUDIT_MS);

    // Only the latest partial of the burst survives the audit window.
    expect(store.partialTextMe()).toBe('partial 3');
  });

  it('routes simultaneous "me"/"others" partials into their own slots (an "others:2" sub-identity collapses into "others")', () => {
    vi.useFakeTimers();
    transcriber.emitPartial({ meetingId: toMeetingId('m-1'), text: 'I think we should', speaker: 'me' });
    transcriber.emitPartial({ meetingId: toMeetingId('m-1'), text: 'actually I disagree', speaker: 'others:2' });
    vi.advanceTimersByTime(PARTIAL_UI_AUDIT_MS);

    expect(store.partialTextMe()).toBe('I think we should');
    expect(store.partialTextOthers()).toBe('actually I disagree');
  });

  it('does not throttle finals — each one lands as soon as it arrives', () => {
    transcriber.emitFinal({
      meetingId: toMeetingId('m-1'),
      segment: transcriptSegment({ startSec: 0, endSec: 1, text: 'immediate final' }),
    });
    expect(store.finalizedSegments().map((segment) => segment.text)).toEqual(['immediate final']);
  });

  it('keeps all 20 sequential finals rendered in order, never dropping or reordering any', () => {
    for (let index = 0; index < 20; index += 1) {
      transcriber.emitFinal({
        meetingId: toMeetingId('m-1'),
        segment: transcriptSegment({ startSec: index, endSec: index + 1, text: `Line ${index}` }),
      });
    }

    const texts = store.finalizedSegments().map((segment) => segment.text);
    expect(texts.length).toBe(20);
    expect(texts).toEqual(Array.from({ length: 20 }, (_, index) => `Line ${index}`));
  });

  it('starts with an empty device list and no selected device', () => {
    expect(store.devices()).toEqual([]);
    expect(store.selectedDevice()).toBeNull();
  });

  it('never mutates the devices signal in place', () => {
    const previous = store.devices();

    store.setDevices([{ name: 'Built-in Microphone' }]);

    expect(store.devices()).not.toBe(previous);
    expect(store.devices()[0]?.name).toBe('Built-in Microphone');
  });

  it('clears the selected device back to null', () => {
    store.setSelectedDevice({ name: 'Headset' });
    expect(store.selectedDevice()?.name).toBe('Headset');

    store.setSelectedDevice(null);

    expect(store.selectedDevice()).toBeNull();
  });

  it('starts not summarizing and reflects setSummarizingKey', () => {
    expect(store.summarizingKey()).toBeNull();
    expect(store.summarizing()).toBe(false);

    store.setSummarizingKey({ template: 'meeting-notes', language: 'en' });

    expect(store.summarizingKey()).toEqual({ template: 'meeting-notes', language: 'en' });
    expect(store.summarizing()).toBe(true);
  });

  it('starts with an unset system audio status and defaults captureSource to mixed (both mic and system)', () => {
    expect(store.systemAudioStatus()).toBeUndefined();
    expect(store.captureSource()).toBe('mixed');
  });

  it('reflects setSystemAudioStatus', () => {
    store.setSystemAudioStatus({ kind: 'permission_denied', restartRequired: true });

    expect(store.systemAudioStatus()).toEqual({ kind: 'permission_denied', restartRequired: true });
  });

  it('reflects setCaptureSource and persists it via PreferencesPort', () => {
    store.setCaptureSource('system');

    expect(store.captureSource()).toBe('system');
    expect(preferences.get(CAPTURE_SOURCE_PREFERENCE_KEY)).toBe('system');
  });

  it('reads a stored capture source preference back across a store rebuild', () => {
    store.setCaptureSource('microphone');
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);
    expect(rebuiltStore.captureSource()).toBe('microphone');
  });

  it('falls back to mixed when the stored capture source preference is invalid', () => {
    preferences.set(CAPTURE_SOURCE_PREFERENCE_KEY, 'not-a-real-source');
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);
    expect(rebuiltStore.captureSource()).toBe('mixed');
  });

  it('starts with no audio sources and defaults the selection to all system output', () => {
    expect(store.audioSources()).toEqual([]);
    expect(store.selectedAudioSource()).toBe(ALL_SYSTEM_AUDIO_SOURCE_ID);
    expect(store.effectiveSystemSource()).toBeNull();
  });

  it('never mutates the audioSources signal in place', () => {
    const previous = store.audioSources();

    store.setAudioSources([{ id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' }]);

    expect(store.audioSources()).not.toBe(previous);
    expect(store.audioSources()).toEqual([{ id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' }]);
  });

  it('reflects setSelectedAudioSource and persists it via PreferencesPort', () => {
    store.setSelectedAudioSource('app:teams');

    expect(store.selectedAudioSource()).toBe('app:teams');
    expect(preferences.get(AUDIO_SOURCE_PREFERENCE_KEY)).toBe('app:teams');
  });

  it('reads a stored audio-source preference back across a store rebuild', () => {
    store.setSelectedAudioSource('app:teams');
    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);
    expect(rebuiltStore.selectedAudioSource()).toBe('app:teams');
  });

  it('reflects the effective system source reported by the recorder once a recording starts', async () => {
    await recorder.start('Standup', undefined, 'system', 'app:demo');

    expect(store.effectiveSystemSource()).toEqual({ id: 'app:demo', name: 'Demo App' });
  });

  it('reflects a fallback effective source when the requested system source is no longer available', async () => {
    await recorder.start('Standup', undefined, 'mixed', 'app:vanished');

    expect(store.effectiveSystemSource()).toEqual({ id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' });
  });

  it('updates the effective system source when the backend resolves it via a follow-up state event after the initial null', () => {
    // The initial `recording://state` event necessarily carries
    // `effectiveSystemSource: null` — the capture backend hasn't resolved
    // the system source yet when start_recording returns.
    recorder.emitEffectiveSystemSource(null);
    expect(store.effectiveSystemSource()).toBeNull();

    // The worker's follow-up event once the system-audio tap is live.
    recorder.emitEffectiveSystemSource({ id: 'app:demo', name: 'Demo App' });

    expect(store.effectiveSystemSource()).toEqual({ id: 'app:demo', name: 'Demo App' });
  });

  it('starts with no summary languages and defaults the selection to en', () => {
    expect(store.summaryLanguages()).toEqual([]);
    expect(store.selectedSummaryLanguage()).toBe('en');
  });

  it('never mutates the summaryLanguages signal in place', () => {
    const previous = store.summaryLanguages();

    store.setSummaryLanguages([{ code: 'fr', label: 'French' }]);

    expect(store.summaryLanguages()).not.toBe(previous);
    expect(store.summaryLanguages()).toEqual([{ code: 'fr', label: 'French' }]);
  });

  it('reflects setSelectedSummaryLanguage and persists it via PreferencesPort', () => {
    store.setSelectedSummaryLanguage('fr');

    expect(store.selectedSummaryLanguage()).toBe('fr');
    expect(preferences.get(SUMMARY_LANGUAGE_PREFERENCE_KEY)).toBe('fr');
  });

  it('reads the selected summary language back from PreferencesPort across a store rebuild', () => {
    store.setSelectedSummaryLanguage('fr');

    TestBed.resetTestingModule();
    configureStore(preferences);
    const rebuiltStore = TestBed.inject(MeetingsStore);

    expect(rebuiltStore.selectedSummaryLanguage()).toBe('fr');
  });

  it('starts with an empty summary cache and no app version', () => {
    expect(store.summaryCache().size).toBe(0);
    expect(store.getSummaryCacheEntry(MEETING_ID, 'key-points', 'en')).toBeUndefined();
    expect(store.appVersion()).toBeUndefined();
  });

  it('setSummaryCacheLoading records a loading entry for that exact (meeting, template, language)', () => {
    const previous = store.summaryCache();

    store.setSummaryCacheLoading(MEETING_ID, 'key-points', 'en');

    expect(store.summaryCache()).not.toBe(previous);
    expect(store.getSummaryCacheEntry(MEETING_ID, 'key-points', 'en')).toEqual({ status: 'loading' });
  });

  it('setSummaryCacheResult with a summary records a loaded entry', () => {
    const summary = { template: 'key-points', markdown: '# Points', createdAt: new Date(), language: 'en', stale: false };

    store.setSummaryCacheResult(MEETING_ID, 'key-points', 'en', summary);

    expect(store.getSummaryCacheEntry(MEETING_ID, 'key-points', 'en')).toEqual({ status: 'loaded', summary });
  });

  it('setSummaryCacheResult with null records the empty state, not an error', () => {
    store.setSummaryCacheResult(MEETING_ID, 'key-points', 'en', null);

    expect(store.getSummaryCacheEntry(MEETING_ID, 'key-points', 'en')).toEqual({ status: 'empty' });
  });

  it('clearSummaryCacheEntry removes only the matching entry', () => {
    store.setSummaryCacheLoading(MEETING_ID, 'key-points', 'en');
    store.setSummaryCacheLoading(MEETING_ID, 'action-items', 'en');

    store.clearSummaryCacheEntry(MEETING_ID, 'key-points', 'en');

    expect(store.getSummaryCacheEntry(MEETING_ID, 'key-points', 'en')).toBeUndefined();
    expect(store.getSummaryCacheEntry(MEETING_ID, 'action-items', 'en')).toEqual({ status: 'loading' });
  });

  it('reflects setAppVersion', () => {
    store.setAppVersion('0.3.1');

    expect(store.appVersion()).toBe('0.3.1');
  });

  it('starts not importing with no import progress', () => {
    expect(store.importing()).toBe(false);
    expect(store.importProgress()).toBeNull();
  });

  it('reflects setImporting', () => {
    store.setImporting(true);
    expect(store.importing()).toBe(true);

    store.setImporting(false);
    expect(store.importing()).toBe(false);
  });

  it('reflects a pushed import://progress event onto importProgress', () => {
    audioImport.emitProgress({ meetingId: MEETING_ID, phase: 'transcribing', processedSec: 12, totalSec: 60 });

    expect(store.importProgress()).toEqual({ meetingId: MEETING_ID, phase: 'transcribing', processedSec: 12, totalSec: 60 });
  });

  it('resetImport clears both importing and importProgress', () => {
    store.setImporting(true);
    audioImport.emitProgress({ meetingId: MEETING_ID, phase: 'converting', processedSec: 1, totalSec: 10 });

    store.resetImport();

    expect(store.importing()).toBe(false);
    expect(store.importProgress()).toBeNull();
  });
});
