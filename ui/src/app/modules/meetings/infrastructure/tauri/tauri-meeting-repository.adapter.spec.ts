import { TestBed } from '@angular/core/testing';

import { toFolderId } from '../../core/models/folder.model';
import { toMeetingId } from '../../core/models/meeting.model';
import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
import { TauriMeetingRepositoryAdapter } from './tauri-meeting-repository.adapter';

describe('TauriMeetingRepositoryAdapter', () => {
  let adapter: TauriMeetingRepositoryAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriMeetingRepositoryAdapter] });
    adapter = TestBed.inject(TauriMeetingRepositoryAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('list() maps every returned MeetingDto', async () => {
    installTauriInternalsStub(() => [
      {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: null,
        summaries: [],
      },
    ]);

    const meetings = await adapter.list();

    expect(meetings.length).toBe(1);
    expect(meetings[0]?.title).toBe('Standup');
  });

  it('get() fetches by id and maps the MeetingDto', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: null,
        summaries: [],
      };
    });

    const meeting = await adapter.get(toMeetingId('m-1'));

    expect(receivedArgs).toEqual({ id: 'm-1' });
    expect(meeting.id).toBe(toMeetingId('m-1'));
  });

  it('delete() invokes delete_meeting with the id', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return undefined;
    });

    await adapter.delete(toMeetingId('m-1'));

    expect(receivedCmd).toBe('delete_meeting');
    expect(receivedArgs).toEqual({ id: 'm-1' });
  });

  it('rename() invokes rename_meeting with the id and title, and maps the returned MeetingDto', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Renamed',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: null,
        summaries: [],
      };
    });

    const meeting = await adapter.rename(toMeetingId('m-1'), 'Renamed');

    expect(receivedCmd).toBe('rename_meeting');
    expect(receivedArgs).toEqual({ meetingId: 'm-1', title: 'Renamed' });
    expect(meeting.title).toBe('Renamed');
  });

  it('setArchived() invokes set_meeting_archived and maps the returned MeetingDto', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: null,
        summaries: [],
        archived: true,
      };
    });

    const meeting = await adapter.setArchived(toMeetingId('m-1'), true);

    expect(receivedCmd).toBe('set_meeting_archived');
    expect(receivedArgs).toEqual({ meetingId: 'm-1', archived: true });
    expect(meeting.archived).toBe(true);
  });

  it('setFolder() invokes set_meeting_folder with { meetingId, folderId } and maps the returned MeetingDto', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: null,
        summaries: [],
        folderId: 'f-1',
      };
    });

    const meeting = await adapter.setFolder(toMeetingId('m-1'), toFolderId('f-1'));

    expect(receivedCmd).toBe('set_meeting_folder');
    expect(receivedArgs).toEqual({ meetingId: 'm-1', folderId: 'f-1' });
    expect(meeting.folderId).toBe(toFolderId('f-1'));
  });

  it('setFolder() with null clears the folder', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: null,
        summaries: [],
      };
    });

    await adapter.setFolder(toMeetingId('m-1'), null);

    expect(receivedArgs).toEqual({ meetingId: 'm-1', folderId: null });
  });

  it('place() invokes set_meeting_placement with the exact arg shape and maps the returned MeetingDto', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: null,
        summaries: [],
        folderId: 'f-1',
      };
    });

    const meeting = await adapter.place(
      toMeetingId('m-1'),
      toFolderId('f-1'),
      true,
      toMeetingId('m-0'),
      toMeetingId('m-2'),
    );

    expect(receivedCmd).toBe('set_meeting_placement');
    expect(receivedArgs).toEqual({
      meetingId: 'm-1',
      folderId: 'f-1',
      archived: true,
      previousId: 'm-0',
      nextId: 'm-2',
    });
    expect(meeting.folderId).toBe(toFolderId('f-1'));
  });

  it('place() passes a null folderId and null previousId/nextId through as null', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return {
        id: 'm-1',
        title: 'Standup',
        createdAt: '2026-01-15T09:00:00Z',
        durationSec: 60,
        audioPath: null,
        transcript: null,
        summaries: [],
      };
    });

    await adapter.place(toMeetingId('m-1'), null, false, null, null);

    expect(receivedArgs).toEqual({
      meetingId: 'm-1',
      folderId: null,
      archived: false,
      previousId: null,
      nextId: null,
    });
  });

  it('export() maps the domain format to the Rust wire value', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return undefined;
    });

    await adapter.export(toMeetingId('m-1'), 'txt', '/tmp/out.txt');

    expect(receivedArgs).toEqual({ meetingId: 'm-1', format: 'text', dest: '/tmp/out.txt' });
  });
});
