import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { MeetingId } from '../../../core/models/meeting.model';
import { toMeetingId } from '../../../core/models/meeting.model';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';
import { AudioPlayerComponent } from './audio-player.component';

/**
 * Meeting-switch regressions: a slow audio-url response for a previously
 * selected meeting must never overwrite the newest one (stale-response race),
 * the outgoing <audio> element must be paused before it is destroyed by the
 * loading/switch branch (media tail keeps playing otherwise), and playback
 * signals must describe the freshly loaded element.
 *
 * The multipart describe extends the same stale-load guarantee across the
 * async multi-URL chunk resolution (RED).
 */

/** Port/facade view of one playable chunk (see adapter spec for the wire DTO). */
interface AudioChunkView {
  readonly url: string;
  readonly startSec: number;
  readonly durationSec: number;
}

const LEGACY_CHUNKS: readonly AudioChunkView[] = [
  { url: 'tauri://audio.wav', startSec: 0, durationSec: 0 },
];

const PART_ONE: AudioChunkView = {
  url: 'asset://localhost/audio.wav',
  startSec: 0,
  durationSec: 60,
};
const PART_TWO: AudioChunkView = {
  url: 'asset://localhost/audio.part-0002.wav',
  startSec: 60,
  durationSec: 40,
};
const M2_CHUNK: AudioChunkView = {
  url: 'tauri://m2.wav',
  startSec: 0,
  durationSec: 90,
};

class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
  getAudioChunks = vi.fn().mockResolvedValue(LEGACY_CHUNKS);
}

describe('AudioPlayerComponent meeting switch', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [AudioPlayerComponent],
      providers: [
        { provide: MeetingsFacade, useClass: MockMeetingsFacade },
      ],
    });
  });

  const renderWithAudio = async (): Promise<ComponentFixture<AudioPlayerComponent>> => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    facade.getAudioUrl = vi.fn().mockResolvedValue('tauri://audio.wav');
    facade.getAudioChunks = vi.fn().mockResolvedValue(LEGACY_CHUNKS);

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    await Promise.resolve();
    fixture.detectChanges();
    return fixture;
  };

  it('ignores a stale audio-url response after a rapid meeting switch', async () => {
    const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
    const pending = new Map<string, (url: string | null) => void>();
    const pendingChunks = new Map<string, (chunks: readonly AudioChunkView[]) => void>();
    facade.getAudioUrl = vi.fn((id: MeetingId) =>
      new Promise<string | null>((resolve) => {
        pending.set(id, resolve);
      }),
    );
    facade.getAudioChunks = vi.fn((id: MeetingId) =>
      new Promise<readonly AudioChunkView[]>((resolve) => {
        pendingChunks.set(id, resolve);
      }),
    );

    const fixture = TestBed.createComponent(AudioPlayerComponent);
    const component = fixture.componentInstance;
    fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
    fixture.componentRef.setInput('hasAudio', true);
    fixture.detectChanges();

    // Switch again before m1's response lands.
    fixture.componentRef.setInput('meetingId', toMeetingId('m2'));
    fixture.detectChanges();

    pending.get('m2')?.('tauri://m2.wav');
    pendingChunks.get('m2')?.([M2_CHUNK]);
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();
    expect(component.url()).toBe('tauri://m2.wav');

    // m1's slow response arrives late — it must not resurrect m1, neither as
    // a single URL nor as a multi-chunk timeline.
    pending.get('m1')?.('tauri://m1.wav');
    pendingChunks.get('m1')?.([PART_ONE, PART_TWO]);
    await Promise.resolve();
    await Promise.resolve();
    fixture.detectChanges();

    expect(component.url()).toBe('tauri://m2.wav');
    expect(component.duration()).toBe(M2_CHUNK.durationSec);
    expect(facade.getAudioUrl).toHaveBeenCalledTimes(2);
    // RED today: the player never calls the chunks API; stale protection must
    // cover the async multi-URL resolution once it does.
    expect(facade.getAudioChunks).toHaveBeenCalledTimes(2);
  });

  it('pauses the previous audio element when the meeting switches', async () => {
    const fixture = await renderWithAudio();
    const audio1 = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    const pauseSpy = vi.spyOn(audio1, 'pause');

    fixture.componentRef.setInput('meetingId', toMeetingId('m2'));
    fixture.detectChanges();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('pauses the audio element when the component is destroyed', async () => {
    const fixture = await renderWithAudio();
    const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    const pauseSpy = vi.spyOn(audio, 'pause');

    fixture.destroy();

    expect(pauseSpy).toHaveBeenCalledTimes(1);
  });

  it('resets playing, currentTime and duration when the next meeting finishes loading', async () => {
    const fixture = await renderWithAudio();
    const component = fixture.componentInstance;
    const audio1 = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    component['_duration'].set(100);
    audio1.currentTime = 40;
    audio1.dispatchEvent(new Event('play'));
    audio1.dispatchEvent(new Event('timeupdate'));
    fixture.detectChanges();
    expect(component.playing()).toBe(true);
    expect(component.currentTime()).toBe(40);

    fixture.componentRef.setInput('meetingId', toMeetingId('m2'));
    fixture.detectChanges();
    await Promise.resolve();
    fixture.detectChanges();

    expect(component.playing()).toBe(false);
    expect(component.currentTime()).toBe(0);
    expect(component.duration()).toBe(0);

    const audio2 = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
    expect(audio2).toBeTruthy();
    expect(audio2).not.toBe(audio1);
  });

  describe('multipart meeting switch (RED: stale multi-chunk loads)', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const flush = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(0);
    };

    it('resets multipart playback state when the next meeting finishes loading', async () => {
      const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
      facade.getAudioUrl = vi.fn().mockResolvedValue(null);
      facade.getAudioChunks = vi.fn(async (id: MeetingId) =>
        id === 'm1' ? [PART_ONE, PART_TWO] : LEGACY_CHUNKS,
      );

      const fixture = TestBed.createComponent(AudioPlayerComponent);
      const component = fixture.componentInstance;
      fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
      fixture.componentRef.setInput('hasAudio', true);
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
      expect(component.url()).toBe(PART_ONE.url);

      const audio = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
      vi.spyOn(audio, 'play').mockResolvedValue(undefined);
      audio.dispatchEvent(new Event('play'));
      audio.dispatchEvent(new Event('ended'));
      await flush();
      fixture.detectChanges();
      expect(component.url()).toBe(PART_TWO.url);
      expect(component.playing()).toBe(true);

      fixture.componentRef.setInput('meetingId', toMeetingId('m2'));
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();

      // Fresh meeting: no carried-over part, position, or total.
      expect(component.playing()).toBe(false);
      expect(component.currentTime()).toBe(0);
      expect(component.duration()).toBe(0);
      expect(component.url()).toBe('tauri://audio.wav');
    });

    it('drops an in-flight chunk advance when the meeting switches', async () => {
      const facade = TestBed.inject(MeetingsFacade) as unknown as MockMeetingsFacade;
      facade.getAudioUrl = vi.fn().mockResolvedValue(null);
      facade.getAudioChunks = vi.fn(async (id: MeetingId) =>
        id === 'm1' ? [PART_ONE, PART_TWO] : LEGACY_CHUNKS,
      );

      const fixture = TestBed.createComponent(AudioPlayerComponent);
      const component = fixture.componentInstance;
      fixture.componentRef.setInput('meetingId', toMeetingId('m1'));
      fixture.componentRef.setInput('hasAudio', true);
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
      expect(component.url()).toBe(PART_ONE.url);

      const audio1 = fixture.nativeElement.querySelector('audio') as HTMLAudioElement;
      vi.spyOn(audio1, 'play').mockResolvedValue(undefined);

      // Switch mid-part: the outgoing element is destroyed; a late `ended`
      // from its media tail must not advance the NEW meeting to m1's part 2.
      fixture.componentRef.setInput('meetingId', toMeetingId('m2'));
      fixture.detectChanges();
      await flush();
      fixture.detectChanges();
      expect(component.url()).toBe('tauri://audio.wav');

      audio1.dispatchEvent(new Event('ended'));
      await flush();
      fixture.detectChanges();

      expect(component.url()).toBe('tauri://audio.wav');
      expect(component.currentTime()).toBe(0);
      expect(component.playing()).toBe(false);
    });
  });
});
