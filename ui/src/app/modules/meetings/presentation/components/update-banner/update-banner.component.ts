import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import type { UpdateCheck } from '../../../core/models/update.model';

/**
 * Non-blocking "an update exists" banner. Renders ONLY for
 * `check().status === 'available'` with a version that hasn't already been
 * dismissed — `'failed'`/`'skipped'`/`'up-to-date'` (and a matching
 * `dismissedVersion`) all render nothing, by design: a failed background
 * check is never a user-facing problem, and must never interrupt a
 * meeting. Offers a clipboard copy of the download link instead of an
 * opener dependency — see `tauri-plugin-opener` removal in ADR history.
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

  readonly dismissed = output<void>();

  protected readonly copied = signal(false);

  /** Narrows `check()` to the `'available'` case not yet dismissed, or `undefined` when nothing should render. */
  protected readonly bannerInfo = computed(() => {
    const current = this.check();
    if (current?.status !== 'available') {
      return undefined;
    }
    return current.version !== this.dismissedVersion() ? current : undefined;
  });

  async copyDownloadLink(url: string): Promise<void> {
    await navigator.clipboard.writeText(url);
    this.copied.set(true);
  }

  dismiss(): void {
    this.copied.set(false);
    this.dismissed.emit();
  }
}
