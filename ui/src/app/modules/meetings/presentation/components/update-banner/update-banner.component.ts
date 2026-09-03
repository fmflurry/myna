import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { MeetingsErrorCode } from '../../../core/models/recording-state.model';
import type { UpdateCheck, UpdateInstallState } from '../../../core/models/update.model';

/**
 * Release page shown by the fallback "Copy release link" action when the
 * check payload's `downloadUrl` is not a GitHub release-download URL we can
 * transform (empty, foreign host, unexpected shape). Matches the updater
 * endpoint's repo (`tauri.conf.json` → `github.com/fmflurry/myna`).
 */
export const FALLBACK_RELEASES_URL = 'https://github.com/fmflurry/myna/releases';

/** GitHub release asset URL shape: `https://github.com/{owner}/{repo}/releases/download/{tag}/{asset}`. */
const GITHUB_DOWNLOAD_URL = /^(https:\/\/github\.com\/[^/]+\/[^/]+)\/releases\/download\/([^/]+)\//;

/**
 * The updater manifest's `downloadUrl` is the raw tarball asset URL — useless
 * to a human. This derives the GitHub RELEASE PAGE for that exact version
 * (`…/releases/tag/{tag}`); anything unparseable falls back to the plain
 * releases page constant rather than handing the user a dead tarball link.
 */
export function releasePageUrl(downloadUrl: string): string {
  const match = GITHUB_DOWNLOAD_URL.exec(downloadUrl);
  return match === null ? FALLBACK_RELEASES_URL : `${match[1]}/releases/tag/${match[2]}`;
}

/** User-facing copy for the Rust install-gate recording refusal (Busy gate). */
const RECORDING_REFUSAL_MESSAGE = 'Finish your recording before updating.';

/**
 * Maps a Rust install-gate refusal to user-facing wording. The primary
 * signal is the stable {@link MeetingsErrorCode} the facade carries from
 * the typed `MeetingsError` (`'BUSY'` = the recording gate) — machine
 * readable and immune to message rewording. The `/recording/i` sniff
 * remains only as a fallback for rejections that arrived without a code
 * (e.g. a failed `update://done` event); anything else is already
 * human-readable English from the updater and passes through verbatim.
 */
export function describeInstallFailure(message: string, code?: MeetingsErrorCode): string {
  return code === 'BUSY' || /recording/i.test(message) ? RECORDING_REFUSAL_MESSAGE : message;
}

/** Which slice of the install flow the banner renders; `'idle'` means "not started yet". */
type BannerMode = 'available' | 'downloading' | 'ready' | 'failed';

/**
 * Update banner driving the one-click install flow. Renders ONLY for
 * `check().status === 'available'` with a version that hasn't already been
 * dismissed — `'failed'`/`'skipped'`/`'up-to-date'` (and a matching
 * `dismissedVersion`) all render nothing, by design: a failed background
 * check is never a user-facing problem, and must never interrupt a meeting.
 * Once the install machine leaves `'idle'` the banner stays visible for the
 * whole run (no dismiss affordance mid-download), mirroring the facade's
 * `idle → downloading(percent) → ready(version) | failed(message)` states:
 * available offers [Update], downloading shows a disabled "Downloading… N%"
 * button, ready offers [Restart now] (disabled while recording), and failed
 * shows a mapped error with [Retry]. Clipboard copy survives ONLY as the
 * error-path fallback, pointing at the GitHub release page, never the
 * tarball URL — see {@link releasePageUrl}.
 */
@Component({
  selector: 'app-update-banner',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './update-banner.component.html',
  styleUrl: './update-banner.component.scss',
})
export class UpdateBannerComponent {
  readonly check = input<UpdateCheck | undefined>(undefined);
  readonly dismissedVersion = input<string | null>(null);
  /** Drives the unsigned-build mic-permission-reset caveat; always `false` today — no signed build exists yet. */
  readonly signed = input(false);
  /** Snapshot of the facade's install state machine; `'idle'` renders the plain "update available" view. */
  readonly installState = input<UpdateInstallState>({ status: 'idle' });
  /** True while a recording is in progress — [Restart now] refuses to fire over a live session. */
  readonly recording = input(false);
  /** Message from a rejected `restartApp()`, surfaced by the shell handler; `null` hides it. */
  readonly restartError = input<string | null>(null);

  readonly dismissed = output<void>();
  readonly updateRequested = output<void>();
  readonly restartRequested = output<void>();

  /** Transient "Copied!" feedback on the release-link fallback button. */
  protected readonly copied = signal(false);

  /** Narrows `check()` to the `'available'` case not yet dismissed, or `undefined` when nothing should render. */
  protected readonly bannerInfo = computed(() => {
    const current = this.check();
    if (current?.status !== 'available') {
      return undefined;
    }
    return current.version !== this.dismissedVersion() ? current : undefined;
  });

  protected readonly mode = computed<BannerMode>(() => {
    const state = this.installState();
    return state.status === 'idle' ? 'available' : state.status;
  });

  /**
   * "N%" for the downloading button; the fractional wire percent rounded
   * to a whole number. Empty for an indeterminate tick (`percent: null` —
   * no `Content-Length` server-side) so the button reads "Downloading…"
   * with no fabricated number.
   */
  protected readonly percentLabel = computed(() => {
    const state = this.installState();
    return state.status === 'downloading' && state.percent !== null ? `${Math.round(state.percent)}%` : '';
  });

  /** Ready-state headline; an empty installed version is honestly "version unknown", never a blank. */
  protected readonly readyMessage = computed(() => {
    const state = this.installState();
    if (state.status !== 'ready') {
      return '';
    }
    return state.version.length > 0
      ? `Myna ${state.version} is installed. Restart to apply.`
      : 'Installed, version unknown. Restart to apply.';
  });

  protected readonly failureMessage = computed(() => {
    const state = this.installState();
    return state.status === 'failed' ? describeInstallFailure(state.message, state.code) : '';
  });

  /** Copies the GitHub release PAGE for the offered version — never the raw tarball URL. */
  copyReleaseLink(downloadUrl: string): void {
    void navigator.clipboard.writeText(releasePageUrl(downloadUrl)).then(() => this.copied.set(true));
  }

  restart(): void {
    this.restartRequested.emit();
  }

  update(): void {
    this.copied.set(false);
    this.updateRequested.emit();
  }

  retry(): void {
    this.update();
  }

  dismiss(): void {
    this.dismissed.emit();
  }
}
