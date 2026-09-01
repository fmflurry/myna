import { Injectable } from '@angular/core';

import type { MeetingId } from '../../core/models/meeting.model';
import { AudioRepositoryPort } from '../../core/ports/audio-repository.port';
import { getMeetingAudioUrl } from './ipc';

/**
 * `AudioRepositoryPort` implementation backed by Tauri IPC.
 * Uses `get_meeting_audio_path` command and converts the path to a playable URL.
 */
@Injectable()
export class TauriAudioRepositoryAdapter extends AudioRepositoryPort {
  override async getAudioUrl(meetingId: MeetingId): Promise<string | null> {
    return getMeetingAudioUrl(meetingId);
  }
}
