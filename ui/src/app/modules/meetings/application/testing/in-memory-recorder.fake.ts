import { Injectable } from '@angular/core';
import { Observable, Subject } from 'rxjs';

import type { AudioDevice, AudioLevel } from '../../core/models/audio-device.model';
import { ALL_SYSTEM_AUDIO_SOURCE_ID, type AudioSource } from '../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../core/models/capture-source.model';
import type { Meeting } from '../../core/models/meeting.model';
import { toMeetingId } from '../../core/models/meeting.model';
import type { RecordingState } from '../../core/models/recording-state.model';
import { RecorderPort } from '../../core/ports/recorder.port';

/** In-memory RecorderPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryRecorderFake extends RecorderPort {
  private readonly devices: readonly AudioDevice[] = [{ name: 'Built-in Microphone' }];
  private readonly outputDevices: readonly AudioDevice[] = [{ name: 'Built-in Output' }];
  private audioSources: readonly AudioSource[] = [
    { id: ALL_SYSTEM_AUDIO_SOURCE_ID, name: 'All system audio' },
    { id: 'app:demo', name: 'Demo App' },
  ];
  private readonly stateSubject = new Subject<RecordingState>();
  private readonly levelSubject = new Subject<AudioLevel>();
  private readonly effectiveSystemSourceSubject = new Subject<AudioSource | null>();

  private currentState: RecordingState = 'idle';
  private currentMeeting: Meeting | undefined;
  private nextId = 1;
  /** `unknown` mirrors the real backend's default: no preflight API exists for the audio permission. */
  private audioStatus: SystemAudioStatus = { kind: 'unknown' };
  private lastRequestedDevice: string | undefined;
  private lastRequestedSource: CaptureSource | undefined;
  private lastRequestedSystemSource: string | undefined;
  private effectiveSystemSource: AudioSource | null = null;

  override async start(
    title: string,
    deviceName?: string,
    source?: CaptureSource,
    systemSource?: string,
  ): Promise<Meeting> {
    this.lastRequestedDevice = deviceName;
    this.lastRequestedSource = source;
    this.lastRequestedSystemSource = systemSource;
    this.effectiveSystemSource = this.resolveEffectiveSystemSource(source, systemSource);
    this.effectiveSystemSourceSubject.next(this.effectiveSystemSource);
    this.currentMeeting = {
      id: toMeetingId(`meeting-${this.nextId++}`),
      title,
      createdAt: new Date(),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false,
      hasSystemTrack: false,
      droppedAudioChunks: 0,
    };
    this.currentState = 'recording';
    this.stateSubject.next(this.currentState);
    return this.currentMeeting;
  }

  /**
   * Mirrors the real backend's fallback behaviour: an unrecognized
   * `systemSource` id (e.g. an app that has since quit) falls back to the
   * all-output source, never to a silent failure. `null` whenever the
   * requested capture source excludes system audio entirely.
   */
  private resolveEffectiveSystemSource(
    source: CaptureSource | undefined,
    systemSource: string | undefined,
  ): AudioSource | null {
    if (source === 'microphone') {
      return null;
    }
    const [fallback] = this.audioSources;
    return this.audioSources.find((candidate) => candidate.id === systemSource) ?? fallback ?? null;
  }

  override async stop(): Promise<Meeting> {
    const meeting = this.currentMeeting;
    if (!meeting) {
      throw new Error('No recording in progress.');
    }
    this.currentState = 'idle';
    this.currentMeeting = undefined;
    this.stateSubject.next(this.currentState);
    return meeting;
  }

  override async cancel(): Promise<void> {
    this.currentMeeting = undefined;
    this.currentState = 'idle';
    this.stateSubject.next(this.currentState);
  }

  override async state(): Promise<RecordingState> {
    return this.currentState;
  }

  override levels(): Observable<AudioLevel> {
    return this.levelSubject.asObservable();
  }

  override stateChanges(): Observable<RecordingState> {
    return this.stateSubject.asObservable();
  }

  override effectiveSystemSourceChanges(): Observable<AudioSource | null> {
    return this.effectiveSystemSourceSubject.asObservable();
  }

  override async listDevices(): Promise<readonly AudioDevice[]> {
    return this.devices;
  }

  override async defaultDevice(): Promise<AudioDevice> {
    const [first] = this.devices;
    if (!first) {
      throw new Error('No audio devices available.');
    }
    return first;
  }

  override async listOutputDevices(): Promise<readonly AudioDevice[]> {
    return this.outputDevices;
  }

  override async defaultOutputDevice(): Promise<AudioDevice> {
    const [first] = this.outputDevices;
    if (!first) {
      throw new Error('No audio output devices available.');
    }
    return first;
  }

  override async listAudioSources(): Promise<readonly AudioSource[]> {
    return this.audioSources;
  }

  override async systemAudioStatus(): Promise<SystemAudioStatus> {
    return this.audioStatus;
  }

  override async requestSystemAudioPermission(): Promise<SystemAudioStatus> {
    return this.audioStatus;
  }

  /** Test helper: push a synthetic audio level onto the levels() stream. */
  emitLevel(level: AudioLevel): void {
    this.levelSubject.next(level);
  }

  /**
   * Test helper: push an effective system source onto the
   * effectiveSystemSourceChanges() stream, simulating a `recording://state`
   * event — e.g. the backend resolving the system source via a follow-up
   * event after the initial one carried `null`.
   */
  emitEffectiveSystemSource(source: AudioSource | null): void {
    this.effectiveSystemSourceSubject.next(source);
  }

  /** Test helper: control what systemAudioStatus()/requestSystemAudioPermission() resolve to. */
  setSystemAudioStatus(status: SystemAudioStatus): void {
    this.audioStatus = status;
  }

  /** Test helper: the `deviceName` argument passed to the most recent start() call. */
  getLastRequestedDevice(): string | undefined {
    return this.lastRequestedDevice;
  }

  /** Test helper: the `source` argument passed to the most recent start() call. */
  getLastRequestedSource(): CaptureSource | undefined {
    return this.lastRequestedSource;
  }

  /** Test helper: the `systemSource` argument passed to the most recent start() call. */
  getLastRequestedSystemSource(): string | undefined {
    return this.lastRequestedSystemSource;
  }

  /** Test helper: replaces the list of audio sources returned by listAudioSources(). */
  setAudioSources(sources: readonly AudioSource[]): void {
    this.audioSources = sources;
  }
}
