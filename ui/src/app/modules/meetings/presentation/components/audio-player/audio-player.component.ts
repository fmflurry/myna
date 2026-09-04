import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
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
import type { AudioChunk } from '../../../core/ports/audio-repository.port';
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

/** Legacy single-file meeting as one whole-file chunk: element-driven duration, global == local. */
const legacyChunk = (url: string): AudioChunk => ({ url, startSec: 0, durationSec: 0 });

/**
 * Fallback timeline when the chunks request failed or resolved empty: a
 * resolved legacy URL is one whole-file chunk; otherwise a FAILED chunks
 * request is the load error (null) and a successful empty one is "no audio"
 * ([]). Lives as a free function so the caller's closure-mutated settlement
 * state is read at call time rather than frozen by control-flow narrowing.
 */
const fallbackChunks = (
  chunksFailed: boolean,
  legacyUrl: string | null,
): readonly AudioChunk[] | null =>
  legacyUrl !== null ? [legacyChunk(legacyUrl)] : chunksFailed ? null : [];

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
  private readonly cdr = inject(ChangeDetectorRef);

  @ViewChild('audioElement', { static: false }) audioRef?: ElementRef<HTMLAudioElement>;

  // Monotonic token for in-flight audio loads: a response is only allowed to
  // land if it still belongs to the newest request (rapid meeting switch).
  private loadSeq = 0;

  /**
   * Ordered chunks of the CURRENT meeting. Exactly one chunk for legacy
   * single-file audio, empty before load / on no audio. Playback presents
   * them as ONE logical timeline: `url()` is the active chunk, the total
   * duration is the sum, and positions map global <-> (chunk, local).
   */
  private chunks: readonly AudioChunk[] = [];
  private activeIndex = 0;
  /**
   * User intent to keep playing. Survives the native `pause` that fires
   * just before `ended` at natural media end, so a chunk advance can
   * resume seamlessly on the next part.
   */
  private resumeIntent = false;

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
        this.chunks = [];
        this.activeIndex = 0;
        this._url.set(null);
        return;
      }
      this.loadAudio(id);
    });
    // Component torn down while still on the player branch: same guard.
    this.destroyRef.onDestroy(() => {
      this.audioRef?.nativeElement?.pause();
    });
  }

  /**
   * Loads the meeting's playable chunks through `getAudioChunks` and applies
   * them as one timeline, falling back to the legacy single-URL API when the
   * chunks API is unavailable (older facades) or fails / returns nothing the
   * backend can still serve as `audio.wav` (pre-multipart recordings).
   *
   * The legacy URL request is fired FIRST and its settlement tracked via a
   * `.then` callback rather than an extra `await`: the chunks response
   * (usually the slower of the two) then decides synchronously, keeping the
   * whole load at one microtask hop per response — the sequencing the
   * pre-multipart specs pin. Stale responses from a superseded load are
   * dropped via `loadSeq`.
   */
  private async loadAudio(meetingId: MeetingId): Promise<void> {
    const seq = ++this.loadSeq;
    this._loading.set(true);
    this._error.set(null);
    const legacyPromise = this.facade.getAudioUrl(meetingId);
    let chunks: readonly AudioChunk[] | null = null;
    if (typeof this.facade.getAudioChunks === 'function') {
      let legacyState: 'pending' | 'resolved' | 'rejected' = 'pending';
      let legacyUrl: string | null = null;
      legacyPromise.then(
        (url) => {
          legacyState = 'resolved';
          legacyUrl = url;
        },
        () => {
          legacyState = 'rejected';
        },
      );
      try {
        chunks = await this.facade.getAudioChunks(meetingId);
      } catch {
        // Chunks unavailable (e.g. backend predating the command) — the
        // legacy URL below decides whether that is a fallback or an error.
        chunks = null;
      }
      // A newer load has started while this one was in flight — stale.
      if (seq !== this.loadSeq) return;
      if (chunks === null || chunks.length === 0) {
        if (legacyState === 'pending') {
          await legacyPromise.catch(() => undefined);
          if (seq !== this.loadSeq) return;
        }
        chunks = fallbackChunks(chunks === null, legacyUrl);
      }
    } else {
      try {
        const url = await legacyPromise;
        if (seq !== this.loadSeq) return;
        chunks = url !== null ? [legacyChunk(url)] : [];
      } catch {
        if (seq !== this.loadSeq) return;
        chunks = null;
      }
    }
    if (chunks === null) {
      this._url.set(null);
      this._error.set('Failed to load audio');
    } else {
      this.applyTimeline(chunks);
    }
    if (seq === this.loadSeq) {
      this._loading.set(false);
    }
  }

  /** Installs a freshly loaded timeline and rewinds every playback signal. */
  private applyTimeline(chunks: readonly AudioChunk[]): void {
    this.chunks = chunks;
    this.activeIndex = 0;
    this.resumeIntent = false;
    this._url.set(chunks[0]?.url ?? null);
    this._playing.set(false);
    this._currentTime.set(0);
    // Multipart total comes from the chunk metadata; a single legacy chunk
    // carries 0 and learns its duration from `durationchange` instead.
    this._duration.set(chunks.reduce((total, chunk) => total + chunk.durationSec, 0));
  }

  private activeStartSec(): number {
    return this.chunks[this.activeIndex]?.startSec ?? 0;
  }

  /** Chunk containing a global timestamp; a boundary lands on the NEXT chunk. */
  private chunkIndexFor(globalSec: number): number {
    const index = this.chunks.findIndex(
      (chunk) => globalSec < chunk.startSec + chunk.durationSec,
    );
    return index >= 0 ? index : Math.max(0, this.chunks.length - 1);
  }

  /**
   * Swaps the single <audio> element onto `index` at `localSec`, optionally
   * resuming playback — one element, one src swap per part, never JS-side
   * buffering. The [src] binding is flushed before the element is touched so
   * the seek/play act on the NEW source.
   */
  private activateChunk(index: number, localSec: number, resumePlay: boolean): void {
    const chunk = this.chunks[index];
    if (!chunk) return;
    this.activeIndex = index;
    this._url.set(chunk.url);
    this._currentTime.set(chunk.startSec + localSec);
    const element = this.audioRef?.nativeElement;
    if (!element) return;
    this.cdr.detectChanges();
    element.currentTime = localSec;
    if (resumePlay) {
      element.play().catch(() => {
        this._error.set('Playback failed');
      });
    }
  }

  // Native media events are wired through the template (see .html) so they
  // attach exactly when the <audio> element is created — after the async URL
  // resolves — instead of in ngAfterViewInit, where the element does not
  // exist yet. Angular removes them with the view, so no listener leaks.

  onPlay(): void {
    this._playing.set(true);
    this.resumeIntent = true;
    this.playRequested.emit();
  }

  onPause(): void {
    // Natural end-of-media fires `pause` (element.ended === true) right
    // before `ended`; only a real user pause clears the resume intent.
    if (!this.audioRef?.nativeElement.ended) {
      this.resumeIntent = false;
    }
    this._playing.set(false);
    this.pauseRequested.emit();
  }

  onEnded(event: Event): void {
    // A late `ended` from the destroyed element of a previous meeting must
    // never advance or rewind the CURRENT timeline.
    if (event.target !== this.audioRef?.nativeElement) return;
    const next = this.activeIndex + 1;
    if (this.chunks.length > 1 && next < this.chunks.length) {
      this.activateChunk(next, 0, this.resumeIntent);
      return;
    }
    this.resumeIntent = false;
    this._playing.set(false);
    this._currentTime.set(0);
  }

  onTimeUpdate(): void {
    if (this._scrubbing()) return;
    const element = this.audioRef?.nativeElement;
    if (element) {
      this._currentTime.set(this.activeStartSec() + element.currentTime);
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
    // Multipart: the logical total is the sum of chunk metadata and must
    // never shrink when a part's chunk-local duration lands. duration is NaN
    // until metadata has loaded.
    if (this.chunks.length > 1) return;
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
    const globalTime = (percent / 100) * this._duration();
    const index = this.chunkIndexFor(globalTime);
    const chunk = this.chunks[index];
    const localSec = chunk ? Math.max(0, globalTime - chunk.startSec) : globalTime;
    if (index !== this.activeIndex) {
      this.activateChunk(index, localSec, this.resumeIntent && this._playing());
      return;
    }
    element.currentTime = localSec;
    this._currentTime.set(this.activeStartSec() + localSec);
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
