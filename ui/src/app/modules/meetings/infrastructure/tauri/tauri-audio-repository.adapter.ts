import { Injectable } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import { AudioRepositoryPort, type AudioChunk } from '../../core/ports/audio-repository.port';
import { getMeetingAudioChunks, getMeetingAudioUrl } from './ipc';

/**
 * `AudioRepositoryPort` implementation backed by Tauri IPC.
 * Uses `get_meeting_audio_path` command and converts the path to a playable URL.
 */
@Injectable()
export class TauriAudioRepositoryAdapter extends AudioRepositoryPort {
  override async getAudioUrl(meetingId: MeetingId): Promise<string | null> {
    return getMeetingAudioUrl(meetingId);
  }

  /**
   * Seamless multipart playback: converts the backend's ordered chunk paths
   * (`get_meeting_audio_chunks`) to playable asset URLs, preserving order and
   * global-timeline offsets. Empty means "no audio"; failures reject with the
   * typed `MeetingsError` mapped at the IPC seam.
   */
  override async getAudioChunks(meetingId: MeetingId): Promise<readonly AudioChunk[]> {
    return getMeetingAudioChunks(meetingId);
  }
}
