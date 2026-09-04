import { Injectable, OnDestroy, effect, inject } from '@angular/core';

import { RecorderPort } from '../../core/ports/recorder.port';
import { ListDevicesUseCase } from '../use-cases/list-devices.usecase';
import { MeetingsStore } from '../stores/meetings.store';
import { DEVICE_POLL_INTERVAL_MS, clearErrorFromSource, toErrorInfo } from './meetings-facade.support';

/** Error `source` tag for {@link DevicesFacade.loadDevices}; see `clearErrorFromSource`. */
const LOAD_DEVICES_SOURCE = 'loadDevices';
const MAX_DEVICE_POLL_BACKOFF_MS = 60_000;
const DEVICE_POLL_BACKOFF_MS = [DEVICE_POLL_INTERVAL_MS, 15_000, MAX_DEVICE_POLL_BACKOFF_MS] as const;

/**
 * Input/output audio-device listing and selection, split out of
 * `MeetingsFacade` to stay under the project's max-lines limit. The
 * constructor starts a background poll (cpal exposes no
 * default-device-changed callback). Polling pauses during recording and uses
 * bounded failure backoff while idle. Injected directly by `MeetingsFacade`,
 * never by a component — see the module's facade-pattern rule.
 */
@Injectable()
export class DevicesFacade implements OnDestroy {
  private readonly store = inject(MeetingsStore);
  private readonly listDevicesUseCase = inject(ListDevicesUseCase);
  private readonly recorder = inject(RecorderPort);
  private pollHandle: ReturnType<typeof setTimeout> | undefined;
  private pollInFlight = false;
  private consecutivePollFailures = 0;
  private previousRecordingState = this.store.recordingState();
  private readonly originalSetRecordingState = this.store.setRecordingState;
  private readonly recordingStateHandler: MeetingsStore['setRecordingState'] = (recordingState) => {
    this.originalSetRecordingState.call(this.store, recordingState);
    this.handleRecordingState(recordingState);
  };

  readonly devices = this.store.devices;
  readonly selectedDevice = this.store.selectedDevice;
  readonly defaultDevice = this.store.defaultDevice;
  readonly outputDevices = this.store.outputDevices;
  readonly defaultOutputDevice = this.store.defaultOutputDevice;

  constructor() {
    this.store.setRecordingState = this.recordingStateHandler;
    effect(() => {
      this.handleRecordingState(this.store.recordingState());
    });
    this.schedulePoll(DEVICE_POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    this.cancelPoll();
    if (this.store.setRecordingState === this.recordingStateHandler) {
      this.store.setRecordingState = this.originalSetRecordingState;
    }
  }

  /**
   * Re-lists input/output devices AND their OS defaults. Never sets the
   * selection from the default — only clears it when the CURRENT selection
   * (possibly seeded from a stale persisted preference) no longer appears
   * in the fresh list; otherwise the selection is left untouched.
   */
  async loadDevices(): Promise<void> {
    try {
      await this.refreshDevices();
    } catch (caught) {
      this.setLoadDevicesError(caught);
    }
  }

  /** Selects a device by name; an unknown name is a no-op. An empty name clears the selection back to the OS default. */
  selectDevice(name: string): void {
    if (name === '') {
      this.store.setSelectedDevice(null);
      return;
    }
    const match = this.store.devices().find((device) => device.name === name);
    if (match) {
      this.store.setSelectedDevice(match);
    }
  }

  /** Skips a tick that overlaps a still in-flight load; the active load schedules the next poll. */
  private pollDevices(): void {
    if (this.pollInFlight || this.isRecordingActive()) {
      return;
    }
    this.pollInFlight = true;
    void this.refreshDevices()
      .then(() => {
        this.consecutivePollFailures = 0;
      })
      .catch((caught: unknown) => {
        this.consecutivePollFailures += 1;
        this.setLoadDevicesError(caught);
      })
      .finally(() => {
        this.pollInFlight = false;
        if (!this.isRecordingActive()) {
          this.schedulePoll(this.nextPollDelay());
        }
      });
  }

  private async refreshDevices(): Promise<void> {
    const devices = await this.listDevicesUseCase.list();
    this.store.setDevices(devices);
    const current = this.store.selectedDevice();
    if (current && !devices.some((device) => device.name === current.name)) {
      this.store.setSelectedDevice(null);
    }
    this.store.setDefaultDevice(await this.listDevicesUseCase.default());
    this.store.setOutputDevices(await this.recorder.listOutputDevices());
    this.store.setDefaultOutputDevice(await this.recorder.defaultOutputDevice());
    clearErrorFromSource(this.store, LOAD_DEVICES_SOURCE);
  }

  private schedulePoll(delay: number): void {
    this.cancelPoll();
    this.pollHandle = setTimeout(() => {
      this.pollHandle = undefined;
      this.pollDevices();
    }, delay);
  }

  private cancelPoll(): void {
    if (this.pollHandle !== undefined) {
      clearTimeout(this.pollHandle);
      this.pollHandle = undefined;
    }
  }

  private isRecordingActive(): boolean {
    const recordingState = this.store.recordingState();
    return recordingState === 'recording' || recordingState === 'stopping';
  }

  private handleRecordingState(recordingState: ReturnType<MeetingsStore['recordingState']>): void {
    const returnedToIdle = this.previousRecordingState !== 'idle' && recordingState === 'idle';
    this.previousRecordingState = recordingState;
    if (recordingState === 'recording' || recordingState === 'stopping') {
      this.cancelPoll();
      return;
    }
    if (returnedToIdle) {
      this.pollDevices();
    }
  }

  private nextPollDelay(): number {
    const backoffIndex = Math.min(this.consecutivePollFailures, DEVICE_POLL_BACKOFF_MS.length - 1);
    return DEVICE_POLL_BACKOFF_MS[backoffIndex] ?? MAX_DEVICE_POLL_BACKOFF_MS;
  }

  private setLoadDevicesError(caught: unknown): void {
    this.store.setError({ ...toErrorInfo(caught), source: LOAD_DEVICES_SOURCE });
  }
}
