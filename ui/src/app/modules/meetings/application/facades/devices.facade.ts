import { Injectable, OnDestroy, inject } from '@angular/core';

import { RecorderPort } from '../../core/ports/recorder.port';
import { ListDevicesUseCase } from '../use-cases/list-devices.usecase';
import { MeetingsStore } from '../stores/meetings.store';
import { DEVICE_POLL_INTERVAL_MS, toErrorInfo } from './meetings-facade.support';

/**
 * Input/output audio-device listing and selection, split out of
 * `MeetingsFacade` to stay under the project's max-lines limit. The
 * constructor starts a background poll (cpal exposes no
 * default-device-changed callback) that re-runs `loadDevices` every
 * `DEVICE_POLL_INTERVAL_MS`; a tick that overlaps an in-flight load is
 * skipped and dropped, never queued. Injected directly by `MeetingsFacade`,
 * never by a component — see the module's facade-pattern rule.
 */
@Injectable()
export class DevicesFacade implements OnDestroy {
  private readonly store = inject(MeetingsStore);
  private readonly listDevicesUseCase = inject(ListDevicesUseCase);
  private readonly recorder = inject(RecorderPort);
  private readonly pollHandle: ReturnType<typeof setInterval>;
  private pollInFlight = false;

  readonly devices = this.store.devices;
  readonly selectedDevice = this.store.selectedDevice;
  readonly defaultDevice = this.store.defaultDevice;
  readonly outputDevices = this.store.outputDevices;
  readonly defaultOutputDevice = this.store.defaultOutputDevice;

  constructor() {
    this.pollHandle = setInterval(() => this.pollDevices(), DEVICE_POLL_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    clearInterval(this.pollHandle);
  }

  /**
   * Re-lists input/output devices AND their OS defaults. Never sets the
   * selection from the default — only clears it when the CURRENT selection
   * (possibly seeded from a stale persisted preference) no longer appears
   * in the fresh list; otherwise the selection is left untouched.
   */
  async loadDevices(): Promise<void> {
    try {
      const devices = await this.listDevicesUseCase.list();
      this.store.setDevices(devices);
      const current = this.store.selectedDevice();
      if (current && !devices.some((device) => device.name === current.name)) {
        this.store.setSelectedDevice(null);
      }
      this.store.setDefaultDevice(await this.listDevicesUseCase.default());
      this.store.setOutputDevices(await this.recorder.listOutputDevices());
      this.store.setDefaultOutputDevice(await this.recorder.defaultOutputDevice());
      this.store.clearError();
    } catch (caught) {
      this.store.setError(toErrorInfo(caught));
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

  /** Skips (never queues) a tick that overlaps a still in-flight load; the next tick tries again. */
  private pollDevices(): void {
    if (this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    void this.loadDevices().finally(() => {
      this.pollInFlight = false;
    });
  }
}
