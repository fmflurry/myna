import { Injectable } from '@angular/core';

import type { Meeting, MeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import {
  MeetingRepositoryPort,
  type MeetingExportFormat,
} from '../../core/ports/meeting-repository.port';

/** In-memory MeetingRepositoryPort implementation for specs and the placeholder providers. */
@Injectable()
export class InMemoryMeetingRepositoryFake extends MeetingRepositoryPort {
  private meetings: readonly Meeting[] = [];

  override async list(): Promise<readonly Meeting[]> {
    return this.meetings;
  }

  override async get(id: MeetingId): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    return found;
  }

  override async delete(id: MeetingId): Promise<void> {
    this.meetings = this.meetings.filter((meeting) => meeting.id !== id);
  }

  override async rename(id: MeetingId, title: string): Promise<Meeting> {
    const found = this.meetings.find((meeting) => meeting.id === id);
    if (!found) {
      throw new MeetingsError('NOT_FOUND', `Meeting ${id} was not found.`);
    }
    const renamed: Meeting = { ...found, title };
    this.meetings = this.meetings.map((meeting) => (meeting.id === id ? renamed : meeting));
    return renamed;
  }

  override async export(id: MeetingId, format: MeetingExportFormat, dest: string): Promise<void> {
    void id;
    void format;
    void dest;
  }

  /** Test helper: replace the in-memory meeting collection. */
  seed(meetings: readonly Meeting[]): void {
    this.meetings = meetings;
  }
}
