import { ChangeDetectionStrategy, Component, HostListener, input, output } from '@angular/core';

/**
 * First-run (and every-launch-until-decided) consent modal for the
 * check-for-update feature. Purely dumb: knows nothing about
 * `UpdateConsent`/`MeetingsFacade` — the owning shell decides WHEN to show
 * it (`consent() === 'unset'` and no recording in progress) and what each
 * output means. `postponed` (× or Esc) persists nothing, so this reappears
 * on the next launch; `granted`/`declined` are the only outputs the shell
 * turns into a persisted decision.
 */
@Component({
  selector: 'app-update-consent-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './update-consent-dialog.component.html',
  styleUrl: './update-consent-dialog.component.scss',
})
export class UpdateConsentDialogComponent {
  /** Drives the unsigned-build mic caveat; always `false` today — no signed build exists yet. */
  readonly signed = input(false);

  readonly granted = output<void>();
  readonly declined = output<void>();
  readonly postponed = output<void>();

  /** Bound on the component's host, so it's only listening while this dialog is actually mounted. */
  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.postponed.emit();
  }

  grant(): void {
    this.granted.emit();
  }

  decline(): void {
    this.declined.emit();
  }

  dismiss(): void {
    this.postponed.emit();
  }
}
