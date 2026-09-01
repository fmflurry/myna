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
 */
class MockMeetingsFacade {
  getAudioUrl = vi.fn().mockResolvedValue(null);
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
    facade.getAudioUrl = vi.fn((id: MeetingId) =>
      new Promise<string | null>((resolve) => {
        pending.set(id, resolve);
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
    await Promise.resolve();
    fixture.detectChanges();
    expect(component.url()).toBe('tauri://m2.wav');

    // m1's slow response arrives late — it must not resurrect m1.
    pending.get('m1')?.('tauri://m1.wav');
    await Promise.resolve();
    fixture.detectChanges();

    expect(component.url()).toBe('tauri://m2.wav');
    expect(facade.getAudioUrl).toHaveBeenCalledTimes(2);
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
});
