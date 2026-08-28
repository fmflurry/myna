import { toMeetingId } from '../../core/models/meeting.model';
import { mapMeetingExportFormatToDto, mapMeetingDtoToDomain } from './meeting.mapper';

describe('mapMeetingDtoToDomain', () => {
  it('maps a meeting with no audioPath and no transcript, omitting both keys', () => {
    const meeting = mapMeetingDtoToDomain({
      id: 'm-1',
      title: 'Standup',
      createdAt: '2026-01-15T09:00:00Z',
      durationSec: 0,
      audioPath: null,
      transcript: null,
      summaries: [],
      archived: false,
      hasAudio: false,
    });

    expect(meeting).toEqual({
      id: toMeetingId('m-1'),
      title: 'Standup',
      createdAt: new Date('2026-01-15T09:00:00Z'),
      durationSec: 0,
      summaries: [],
      archived: false,
      hasAudio: false,
    });
    expect('audioPath' in meeting).toBe(false);
    expect('transcript' in meeting).toBe(false);
  });

  it('maps a fully populated meeting, including transcript and summary refs', () => {
    const meeting = mapMeetingDtoToDomain({
      id: 'm-2',
      title: 'Planning',
      createdAt: '2026-01-15T09:00:00Z',
      durationSec: 120,
      audioPath: '/data/meetings/m-2/audio.wav',
      transcript: { segments: [{ startSec: 0, endSec: 1, text: 'hi' }] },
      summaries: [
        { template: 'key-points', createdAt: '2026-01-15T09:05:00Z', path: '/x.md', language: 'en' },
      ],
      archived: false,
      hasAudio: true,
    });

    expect(meeting.audioPath).toBe('/data/meetings/m-2/audio.wav');
    expect(meeting.transcript).toEqual({ segments: [{ startSec: 0, endSec: 1, text: 'hi' }] });
    expect(meeting.summaries).toEqual([
      { template: 'key-points', markdown: '', createdAt: new Date('2026-01-15T09:05:00Z'), language: 'en' },
    ]);
  });

  it('maps an archived meeting', () => {
    const meeting = mapMeetingDtoToDomain({
      id: 'm-3',
      title: 'Old standup',
      createdAt: '2026-01-15T09:00:00Z',
      durationSec: 0,
      audioPath: null,
      transcript: null,
      summaries: [],
      archived: true,
      hasAudio: false,
    });

    expect(meeting.archived).toBe(true);
  });
});

describe('mapMeetingExportFormatToDto', () => {
  it('maps txt to the Rust text variant', () => {
    expect(mapMeetingExportFormatToDto('txt')).toBe('text');
  });

  it('passes markdown and json through unchanged', () => {
    expect(mapMeetingExportFormatToDto('markdown')).toBe('markdown');
    expect(mapMeetingExportFormatToDto('json')).toBe('json');
  });
});
