import { Injectable } from '@angular/core';
import type { Observable } from 'rxjs';
import { map } from 'rxjs';

import type { AudioDevice, AudioLevel } from '../../core/models/audio-device.model';
import type { AudioSource } from '../../core/models/audio-source.model';
import type { CaptureSource, SystemAudioStatus } from '../../core/models/capture-source.model';
import type { Meeting } from '../../core/models/meeting.model';
import type { RecordingState } from '../../core/models/recording-state.model';
import { RecorderPort } from '../../core/ports/recorder.port';
import type { AudioSourceDto, DeviceInfoDto } from '../dto/device.dto';
import { mapMeetingDtoToDomain } from '../mappers/meeting.mapper';
import { invokeCommand, onEvent } from './ipc';

const toAudioDevice = (dto: DeviceInfoDto): AudioDevice => ({ name: dto.name });
const toAudioSource = (dto: AudioSourceDto): AudioSource => ({ id: dto.id, name: dto.name });

/** `RecorderPort` implementation backed by the Tauri IPC command surface. */
@Injectable()
export class TauriRecorderAdapter extends RecorderPort {
  override async start(
    title: string,
    deviceName?: string,
    source?: CaptureSource,
    systemSource?: string,
  ): Promise<Meeting> {
    const dto = await invokeCommand('start_recording', {
      title,
      ...(deviceName !== undefined ? { device: deviceName } : {}),
      ...(source !== undefined ? { source } : {}),
      ...(systemSource !== undefined ? { systemSource } : {}),
    });
    return mapMeetingDtoToDomain(dto);
  }

  override async stop(): Promise<Meeting> {
    const dto = await invokeCommand('stop_recording', {});
    return mapMeetingDtoToDomain(dto);
  }

  override async cancel(): Promise<void> {
    await invokeCommand('cancel_recording', {});
  }

  override async state(): Promise<RecordingState> {
    const dto = await invokeCommand('recording_state', {});
    return dto.state;
  }

  override levels(): Observable<AudioLevel> {
    return onEvent('recording://level').pipe(map((dto) => ({ rms: dto.rms, dbfs: dto.dbfs })));
  }

  override stateChanges(): Observable<RecordingState> {
    return onEvent('recording://state').pipe(map((dto) => dto.state));
  }

  override effectiveSystemSourceChanges(): Observable<AudioSource | null> {
    return onEvent('recording://state').pipe(
      map((dto) => (dto.effectiveSystemSource ? toAudioSource(dto.effectiveSystemSource) : null)),
    );
  }

  override async listDevices(): Promise<readonly AudioDevice[]> {
    const dtos = await invokeCommand('list_input_devices', {});
    return dtos.map(toAudioDevice);
  }

  override async defaultDevice(): Promise<AudioDevice> {
    const dto = await invokeCommand('default_input_device', {});
    return toAudioDevice(dto);
  }

  override async listOutputDevices(): Promise<readonly AudioDevice[]> {
    const dtos = await invokeCommand('list_output_devices', {});
    return dtos.map(toAudioDevice);
  }

  override async defaultOutputDevice(): Promise<AudioDevice> {
    const dto = await invokeCommand('default_output_device', {});
    return toAudioDevice(dto);
  }

  override async listAudioSources(): Promise<readonly AudioSource[]> {
    const dtos = await invokeCommand('list_audio_sources', {});
    return dtos.map(toAudioSource);
  }

  override async systemAudioStatus(): Promise<SystemAudioStatus> {
    return invokeCommand('system_audio_status', {});
  }

  override async requestSystemAudioPermission(): Promise<SystemAudioStatus> {
    return invokeCommand('request_system_audio_permission', {});
  }
}
