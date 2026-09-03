import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { UpdateCheck, UpdateInstallState } from '../../../core/models/update.model';
import { FALLBACK_RELEASES_URL, releasePageUrl, UpdateBannerComponent } from './update-banner.component';

describe('UpdateBannerComponent', () => {
  const available: UpdateCheck = {
    status: 'available',
    version: '0.4.0',
    notes: 'Faster startup and a fixed crash on import.',
    downloadUrl: 'https://github.com/fmflurry/myna/releases/download/v0.4.0/Myna.app.tar.gz',
  };

  const createFixture = (check: UpdateCheck = available, installState?: UpdateInstallState) => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.componentRef.setInput('check', check);
    if (installState !== undefined) {
      fixture.componentRef.setInput('installState', installState);
    }
    fixture.detectChanges();
    return fixture;
  };

  const banner = (fixture: ReturnType<typeof createFixture>): HTMLElement | null =>
    fixture.nativeElement.querySelector('.update-banner');

  it('renders nothing when no check has run yet', () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();

    expect(banner(fixture)).toBeNull();
  });

  it('renders nothing for a failed check — a failed background check is never a user problem', () => {
    const fixture = createFixture({ status: 'failed', message: 'network error' });

    expect(banner(fixture)).toBeNull();
  });

  it('renders nothing for a skipped check', () => {
    const fixture = createFixture({ status: 'skipped', reason: 'throttled' });

    expect(banner(fixture)).toBeNull();
  });

  it('renders nothing for an up-to-date check', () => {
    const fixture = createFixture({ status: 'up-to-date' });

    expect(banner(fixture)).toBeNull();
  });

  it('renders nothing when the available version already matches dismissedVersion', () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.componentRef.setInput('check', available);
    fixture.componentRef.setInput('dismissedVersion', '0.4.0');
    fixture.detectChanges();

    expect(banner(fixture)).toBeNull();
  });

  it('renders the available version and notes when not dismissed', () => {
    const fixture = createFixture();

    const text: string = banner(fixture)!.textContent ?? '';
    expect(text).toContain('Myna 0.4.0 is available.');
    expect(text).toContain('Faster startup and a fixed crash on import.');
  });

  it('offers [Update] as the primary action in the available state — not a clipboard copy', () => {
    const fixture = createFixture();

    const update: HTMLElement | null = banner(fixture)!.querySelector('.install');
    expect(update).toBeTruthy();
    expect(update!.textContent).toContain('Update');
    // The old primary "Copy download link" action is gone from the available state.
    expect(banner(fixture)!.querySelector('.copy')).toBeNull();
    expect(banner(fixture)!.textContent).not.toContain('Copy download link');
  });

  it('emits updateRequested when [Update] is clicked', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.updateRequested.subscribe(() => emitted.push(undefined));

    banner(fixture)!.querySelector<HTMLElement>('.install')!.click();

    expect(emitted.length).toBe(1);
  });

  it('shows the unsigned-build mic-permission caveat by default', () => {
    const fixture = createFixture();

    expect(banner(fixture)!.querySelector('.caveat')).toBeTruthy();
  });

  it('hides the mic-permission caveat when signed is true', () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.componentRef.setInput('check', available);
    fixture.componentRef.setInput('signed', true);
    fixture.detectChanges();

    expect(banner(fixture)!.querySelector('.caveat')).toBeNull();
  });

  it('downloading: renders a disabled progress button with the rounded percent', () => {
    const fixture = createFixture(available, { status: 'downloading', percent: 42.4 });

    const button: HTMLButtonElement | null = banner(fixture)!.querySelector<HTMLButtonElement>('.install');
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(true);
    expect(button!.textContent).toContain('Downloading');
    expect(button!.textContent).toContain('42%');
  });

  it('downloading: an indeterminate (null) percent renders "Downloading…" with NO fabricated number', () => {
    // FIX 3: percent:null means the server sent no Content-Length —
    // showing "0%" would fabricate progress we don't have.
    const fixture = createFixture(available, { status: 'downloading', percent: null });

    const button: HTMLButtonElement | null = banner(fixture)!.querySelector<HTMLButtonElement>('.install');
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(true);
    expect(button!.textContent).toContain('Downloading');
    expect(button!.textContent).not.toContain('%');
    expect(button!.textContent).not.toContain('0');
  });

  it('downloading: hides the dismiss button — the run must stay visible', () => {
    const fixture = createFixture(available, { status: 'downloading', percent: 10 });

    expect(banner(fixture)!.querySelector('.dismiss')).toBeNull();
  });

  it('ready: offers [Restart now] and a secondary copy-release-link fallback', () => {
    const fixture = createFixture(available, { status: 'ready', version: '0.4.0' });

    const text: string = banner(fixture)!.textContent ?? '';
    expect(text).toContain('Myna 0.4.0 is installed.');
    expect(banner(fixture)!.querySelector('.restart')).toBeTruthy();
    expect(banner(fixture)!.querySelector('.copy')!.textContent).toContain('Copy release link');
  });

  it('ready: clicking [Restart now] emits restartRequested', () => {
    const fixture = createFixture(available, { status: 'ready', version: '0.4.0' });
    const emitted: void[] = [];
    fixture.componentInstance.restartRequested.subscribe(() => emitted.push(undefined));

    banner(fixture)!.querySelector<HTMLElement>('.restart')!.click();

    expect(emitted.length).toBe(1);
  });

  it('ready: [Restart now] is disabled with a tooltip while a recording is active', () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.componentRef.setInput('check', available);
    fixture.componentRef.setInput('installState', { status: 'ready', version: '0.4.0' });
    fixture.componentRef.setInput('recording', true);
    fixture.detectChanges();

    const button: HTMLButtonElement | null = banner(fixture)!.querySelector<HTMLButtonElement>('.restart');
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(true);
    expect(button!.getAttribute('title')).toContain('finish your recording first');
  });

  it('ready: an empty version string reads "Installed, version unknown"', () => {
    const fixture = createFixture(available, { status: 'ready', version: '' });

    expect(banner(fixture)!.textContent).toContain('Installed, version unknown');
  });

  it('ready: surfaces a restart rejection message', () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.componentRef.setInput('check', available);
    fixture.componentRef.setInput('installState', { status: 'ready', version: '0.4.0' });
    fixture.componentRef.setInput('restartError', 'restart request failed');
    fixture.detectChanges();

    expect(banner(fixture)!.textContent).toContain('restart request failed');
  });

  it('failed: maps the Rust recording-gate refusal to friendly wording, never the raw code', () => {
    const fixture = createFixture(available, {
      status: 'failed',
      message: 'cannot install an update while a recording is in progress',
    });

    const text: string = banner(fixture)!.textContent ?? '';
    expect(text).toContain('Finish your recording before updating.');
    expect(text).not.toContain('cannot install an update while a recording is in progress');
  });

  it('failed: the typed BUSY code drives friendly wording even when the message is opaque', () => {
    // FIX 5: MeetingsError.code === 'BUSY' crosses the IPC seam intact —
    // the banner prefers it over message-sniffing; the regex stays as the
    // fallback (previous test).
    const fixture = createFixture(available, {
      status: 'failed',
      message: 'gateway in the mist',
      code: 'BUSY',
    });

    expect(banner(fixture)!.textContent).toContain('Finish your recording before updating.');
  });

  it('failed: passes through other install failure messages verbatim and offers [Retry]', () => {
    const fixture = createFixture(available, { status: 'failed', message: 'signature verification failed' });
    const emitted: void[] = [];
    fixture.componentInstance.updateRequested.subscribe(() => emitted.push(undefined));

    expect(banner(fixture)!.textContent).toContain('signature verification failed');
    banner(fixture)!.querySelector<HTMLElement>('.install')!.click();

    expect(emitted.length).toBe(1);
    expect(banner(fixture)!.querySelector('.copy')!.textContent).toContain('Copy release link');
  });

  it('failed: keeps the dismiss × available', () => {
    const fixture = createFixture(available, { status: 'failed', message: 'boom' });
    const emitted: void[] = [];
    fixture.componentInstance.dismissed.subscribe(() => emitted.push(undefined));

    banner(fixture)!.querySelector<HTMLElement>('.dismiss')!.click();

    expect(emitted.length).toBe(1);
  });

  it('copies the GitHub RELEASE PAGE (not the tarball URL) as the fallback action', async () => {
    const writeText = vi.fn(async (text: string) => {
      void text;
    });
    Object.assign(navigator, { clipboard: { writeText } });
    const fixture = createFixture(available, { status: 'failed', message: 'boom' });

    banner(fixture)!.querySelector<HTMLElement>('.copy')!.click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledWith('https://github.com/fmflurry/myna/releases/tag/v0.4.0');
    expect(banner(fixture)!.querySelector('.copy')!.textContent).toContain('Copied!');
  });

  describe('releasePageUrl', () => {
    it('transforms a GitHub release-download (tarball) URL into the release tag page', () => {
      expect(releasePageUrl(available.downloadUrl)).toBe('https://github.com/fmflurry/myna/releases/tag/v0.4.0');
    });

    it('falls back to the plain releases page for anything it cannot parse', () => {
      expect(releasePageUrl('')).toBe(FALLBACK_RELEASES_URL);
      expect(releasePageUrl('https://example.com/files/Myna.app.tar.gz')).toBe(FALLBACK_RELEASES_URL);
    });
  });

  it('emits dismissed when the × button is clicked in the available state', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.dismissed.subscribe(() => emitted.push(undefined));

    banner(fixture)!.querySelector<HTMLElement>('.dismiss')!.click();

    expect(emitted.length).toBe(1);
  });

  it('ready: hides the dismiss × — the update is already installed', () => {
    const fixture = createFixture(available, { status: 'ready', version: '0.4.0' });

    expect(banner(fixture)!.querySelector('.dismiss')).toBeNull();
  });
});
