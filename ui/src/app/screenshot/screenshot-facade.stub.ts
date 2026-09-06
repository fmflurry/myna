import { signal } from '@angular/core';
import { EMPTY } from 'rxjs';

import type { MeetingsFacade } from '../modules/meetings/application/facades/meetings.facade';
import type { UpdateInstallState } from '../modules/meetings/core/models/update.model';
import {
  makeScreenshotAudioSources,
  makeScreenshotDevices,
  makeScreenshotMeetings,
  makeScreenshotModelsStatus,
  makeScreenshotSummaryLanguages,
  makeScreenshotTemplates,
  type ScreenshotScene,
} from './screenshot-fixtures';

/**
 * Dev-only `MeetingsFacade` stand-in for the screenshot harness.
 *
 * Seeded `signal()` state (the same seam the `meetings-shell.page.spec.ts`
 * hand-rolled stubs use — plain signals + no-op methods, no `vi.mock()`,
 * which is broken in this repo) so the REAL `MeetingsShellPage` renders with
 * zero Tauri IPC, zero models, and zero microphone.
 *
 * Update consent is seeded `'granted'` so the first-run consent dialog never
 * covers a screenshot; the launch check itself is a no-op.
 */

const asyncNoop = async (): Promise<void> => undefined;

const grantedUpdatesStub = () => ({
  consent: () => 'granted' as const,
  lastCheck: () => undefined,
  checking: () => false,
  dismissedVersion: () => null,
  installState: () => ({ status: 'idle' }) satisfies UpdateInstallState,
  loadConsent: asyncNoop,
  grantConsent: asyncNoop,
  declineConsent: asyncNoop,
  checkForUpdate: asyncNoop,
  dismissBanner: () => undefined,
  installUpdate: asyncNoop,
  restartApp: asyncNoop,
});

/** Builds the seeded facade for one screenshot scene (states, not routes). */
export function buildScreenshotFacade(scene: ScreenshotScene): MeetingsFacade {
  const meetings = makeScreenshotMeetings();
  const selectedMeeting =
    scene === 'library' || scene === 'recording'
      ? undefined
      : (meetings.find((meeting) => meeting.title === 'Weekly Standup') ??
        (scene === 'transcription'
          ? meetings.find((meeting) => meeting.title === 'Product Review')
          : undefined));
  const transcriptionSelected =
    scene === 'transcription'
      ? (meetings.find((meeting) => meeting.title === 'Product Review') ?? selectedMeeting)
      : selectedMeeting;

  const syncNoop = (value: unknown): void => {
    void value;
  };

  return {
    meetings: signal(meetings),
    selectedMeeting: signal(transcriptionSelected),
    recordingState: signal('idle'),
    activeRecording: signal(null),
    finalizedSegments: signal([]),
    partialTextMe: signal(''),
    partialTextOthers: signal(''),
    level: signal(undefined),
    templates: signal(makeScreenshotTemplates()),
    modelsStatus: signal(makeScreenshotModelsStatus()),
    summaryStream: signal(''),
    error: signal(undefined),
    busy: signal(false),
    devices: signal(makeScreenshotDevices()),
    selectedDevice: signal({ name: 'Built-in Microphone' }),
    summarizing: signal(false),
    summarizingKey: signal(null),
    startingRecording: signal(false),
    stopPhase: signal(null),
    recordingHealth: signal(null),
    systemAudioStatus: signal({ kind: 'available' }),
    captureSource: signal('microphone'),
    summaryLanguages: signal(makeScreenshotSummaryLanguages()),
    selectedSummaryLanguage: signal('en'),
    summaryGuidelines: signal(''),
    summaryCache: signal(new Map()),
    appVersion: signal('0.0.0-screenshots'),
    audioSources: signal(makeScreenshotAudioSources()),
    selectedAudioSource: signal('system:all'),
    effectiveSystemSource: signal(null),
    splitRatio: signal(0.4),
    transcriptCollapsed: signal(false),
    sidebarWidth: signal(260),
    sidebarCollapsed: signal(false),
    importing: signal(false),
    importProgress: signal(null),
    folders: signal([]),
    expandedFolders: signal(new Set()),
    speakerHistory: signal([]),
    transcriptUndo: signal(null),
    modelDownload: signal(undefined),
    updates: grantedUpdatesStub(),
    settingsRequests: () => EMPTY,
    summaryInstructionDraft: () => ({ text: '', includeGeneral: true }),
    setSummaryInstructionDraft: () => undefined,
    clearSelection: () => undefined,
    clearError: () => undefined,
    selectDevice: syncNoop,
    selectCaptureSource: syncNoop,
    selectAudioSource: syncNoop,
    selectSummaryLanguage: syncNoop,
    setSplitRatio: syncNoop,
    setTranscriptCollapsed: syncNoop,
    setSidebarWidth: syncNoop,
    setSidebarCollapsed: syncNoop,
    toggleFolderExpanded: syncNoop,
    getAudioUrl: async () => null,
    getAudioChunks: async () => [],
    resumeActiveRecording: asyncNoop,
    loadMeetings: asyncNoop,
    openMeeting: asyncNoop,
    deleteMeeting: asyncNoop,
    renameMeeting: asyncNoop,
    setMeetingArchived: asyncNoop,
    editSummary: asyncNoop,
    deleteSummary: asyncNoop,
    summarizeMeeting: asyncNoop,
    cancelSummarization: asyncNoop,
    loadTemplates: asyncNoop,
    checkModels: asyncNoop,
    initializeModels: asyncNoop,
    initializeDiarizationModels: asyncNoop,
    cancelModelDownload: asyncNoop,
    loadDevices: asyncNoop,
    undoLastSpeakerOp: asyncNoop,
    undoLastTranscriptOp: asyncNoop,
    renameSpeaker: asyncNoop,
    removeSpeaker: asyncNoop,
    setSegmentSpeaker: asyncNoop,
    setSegmentSpeakers: asyncNoop,
    deleteTranscriptSegment: asyncNoop,
    deleteTranscriptSection: asyncNoop,
    mergeTranscriptSegmentUp: asyncNoop,
    exportMeeting: asyncNoop,
    importAudio: asyncNoop,
    retranscribeMeeting: asyncNoop,
    cancelImport: asyncNoop,
    diarizeMeeting: asyncNoop,
    checkSystemAudio: asyncNoop,
    requestSystemAudioPermission: asyncNoop,
    loadAudioSources: asyncNoop,
    loadSummaryLanguages: asyncNoop,
    loadSummaryGuidelines: asyncNoop,
    setSummaryGuidelines: asyncNoop,
    loadSummary: asyncNoop,
    loadAppVersion: asyncNoop,
    loadFolders: asyncNoop,
    createFolder: asyncNoop,
    renameFolder: asyncNoop,
    deleteFolder: asyncNoop,
    setMeetingFolder: asyncNoop,
    placeMeeting: asyncNoop,
  } as unknown as MeetingsFacade;
}
