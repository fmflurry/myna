import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import type { MeetingId } from '../../../core/models/meeting.model';
import { MeetingsFacade } from '../../../application/facades/meetings.facade';

const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

/** Pure mm:ss formatter. Guards NaN/Infinity (pre-metadata) and negatives. */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return '0:00';
  }
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

@Component({
  selector: 'app-audio-player',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './audio-player.component.html',
  styleUrl: './audio-player.component.scss',
})
export class AudioPlayerComponent {
  readonly meetingId = input<MeetingId | undefined>(undefined);
  readonly hasAudio = input<boolean>(false);

  readonly playRequested = output<void>();
  readonly pauseRequested = output<void>();

  private readonly facade = inject(MeetingsFacade);
  private readonly destroyRef = inject(DestroyRef);

  @ViewChild('audioElement', { static: false }) audioRef?: ElementRef<HTMLAudioElement>;

  // Monotonic token for in-flight getAudioUrl loads: a response is only
  // allowed to land if it still belongs to the newest request.
  private loadSeq = 0;

  private readonly _url = signal<string | null>(null);
  private readonly _loading = signal<boolean>(false);
  private readonly _error = signal<string | null>(null);
  private readonly _playing = signal<boolean>(false);
  private readonly _currentTime = signal<number>(0);
  private readonly _duration = signal<number>(0);
  private readonly _volume = signal<number>(1);
  private readonly _muted = signal<boolean>(false);
  private readonly _playbackRate = signal<number>(1);
  // True while the user drags (or keyboard-scrubs) the seek slider; suppresses
  // timeupdate-driven value rewrites so the thumb doesn't snap back mid-drag.
  private readonly _scrubbing = signal<boolean>(false);

  readonly url = this._url.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly playing = this._playing.asReadonly();
  readonly currentTime = this._currentTime.asReadonly();
  readonly duration = this._duration.asReadonly();
  readonly volume = this._volume.asReadonly();
  readonly muted = this._muted.asReadonly();
  readonly playbackRate = this._playbackRate.asReadonly();

  readonly currentTimeDisplay = computed(() => formatTime(this._currentTime()));
  readonly durationDisplay = computed(() => formatTime(this._duration()));
  readonly playbackRates = PLAYBACK_RATES;
  readonly seekPercent = computed(() => {
    const d = this._duration();
    const c = this._currentTime();
    return d > 0 ? (c / d) * 100 : 0;
  });

  constructor() {
    effect(() => {
      const id = this.meetingId();
      const hasAudioValue = this.hasAudio();
      // A meeting switch (or losing audio) swaps the template to the
      // loading/empty branch on the next render, destroying the current
      // <audio> element — but its media tail keeps playing. Pause it
      // synchronously before the swap.
      this.audioRef?.nativeElement?.pause();
      if (!id || !hasAudioValue) {
        this._url.set(null);
        return;
      }
      this.loadAudioUrl(id);
    });
    // Component torn down while still on the player branch: same guard.
    this.destroyRef.onDestroy(() => {
      this.audioRef?.nativeElement?.pause();
    });
  }

  private async loadAudioUrl(meetingId: MeetingId): Promise<void> {
    const seq = ++this.loadSeq;
    this._loading.set(true);
    this._error.set(null);
    try {
      const url = await this.facade.getAudioUrl(meetingId);
      // A newer load has started while this one was in flight (rapid meeting
      // switch) — this response is stale and must not overwrite the newest url.
      if (seq !== this.loadSeq) return;
      this._url.set(url);
      this._playing.set(false);
      this._currentTime.set(0);
      this._duration.set(0);
    } catch {
      if (seq !== this.loadSeq) return;
      this._url.set(null);
      this._error.set('Failed to load audio');
    } finally {
      if (seq === this.loadSeq) {
        this._loading.set(false);
      }
    }
  }

  // Native media events are wired through the template (see .html) so they
  // attach exactly when the <audio> element is created — after the async URL
  // resolves — instead of in ngAfterViewInit, where the element does not
  // exist yet. Angular removes them with the view, so no listener leaks.

  onPlay(): void {
    this._playing.set(true);
    this.playRequested.emit();
  }

  onPause(): void {
    this._playing.set(false);
    this.pauseRequested.emit();
  }

  onEnded(): void {
    this._playing.set(false);
    this._currentTime.set(0);
  }

  onTimeUpdate(): void {
    if (this._scrubbing()) return;
    const element = this.audioRef?.nativeElement;
    if (element) {
      this._currentTime.set(element.currentTime);
    }
  }

  // The slider's [value] binding follows seekPercent(); while the user drags,
  // timeupdate (~4×/s) must not rewrite it or the thumb snaps back. Press or
  // focus arms scrubbing; release (pointerup) or keyboard change commits.
  onScrubStart(): void {
    this._scrubbing.set(true);
  }

  onScrubEnd(event: Event): void {
    if (!this._scrubbing()) return;
    this._scrubbing.set(false);
    this.seek(event);
  }

  // Focus loss without a release/change (e.g. tabbing away mid keyboard-scrub)
  // must disarm scrubbing, or timeupdate stays suppressed forever and the
  // slider freezes. Blur only cancels — it never commits (pointerup/change do).
  onScrubCancel(): void {
    this._scrubbing.set(false);
  }

  onDurationChange(): void {
    const element = this.audioRef?.nativeElement;
    if (!element) return;
    // duration is NaN until metadata has loaded.
    this._duration.set(Number.isFinite(element.duration) ? element.duration : 0);
  }

  onMediaError(): void {
    this._error.set('Playback error');
    this._playing.set(false);
  }

  togglePlayPause(): void {
    const element = this.audioRef?.nativeElement;
    if (!element || !this._url()) return;

    if (this._playing()) {
      element.pause();
    } else {
      element.play().catch(() => {
        this._error.set('Playback failed');
      });
    }
  }

  seek(event: Event): void {
    const element = this.audioRef?.nativeElement;
    if (!element || !this._url()) return;
    // duration is 0 until metadata loads; a seek now would compute 0 and
    // silently rewind instead of doing nothing.
    if (this._duration() <= 0) return;

    const input = event.target as HTMLInputElement;
    const percent = parseFloat(input.value);
    const newTime = (percent / 100) * this._duration();
    element.currentTime = newTime;
    this._currentTime.set(newTime);
  }

  // volume/muted/playbackRate reach the element purely through the
  // [volume]/[muted]/[playbackRate] property bindings — single source of
  // truth, so a re-created element (meeting switch) inherits current state.
  setVolume(event: Event): void {
    const input = event.target as HTMLInputElement;
    const newVolume = parseFloat(input.value);
    this._volume.set(newVolume);
    if (newVolume > 0) {
      this._muted.set(false);
    }
  }

  toggleMute(): void {
    this._muted.set(!this._muted());
  }

  setPlaybackRate(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this._playbackRate.set(parseFloat(select.value));
  }
}
