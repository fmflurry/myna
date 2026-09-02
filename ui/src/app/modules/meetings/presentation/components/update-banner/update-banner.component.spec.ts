import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { UpdateCheck } from '../../../core/models/update.model';
import { UpdateBannerComponent } from './update-banner.component';

describe('UpdateBannerComponent', () => {
  const available: UpdateCheck = {
    status: 'available',
    version: '0.4.0',
    notes: 'Faster startup and a fixed crash on import.',
    downloadUrl: 'https://github.com/example/myna/releases/tag/v0.4.0',
  };

  const createFixture = () => {
    const fixture = TestBed.createComponent(UpdateBannerComponent);
    fixture.detectChanges();
    return fixture;
  };

  it('renders nothing when no check has run yet', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.update-banner')).toBeNull();
  });

  it('renders nothing for a failed check — a failed background check is never a user problem', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('check', { status: 'failed', message: 'network error' } satisfies UpdateCheck);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.update-banner')).toBeNull();
  });

  it('renders nothing for a skipped check', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('check', { status: 'skipped', reason: 'throttled' } satisfies UpdateCheck);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.update-banner')).toBeNull();
  });

  it('renders nothing for an up-to-date check', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('check', { status: 'up-to-date' } satisfies UpdateCheck);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.update-banner')).toBeNull();
  });

  it('renders nothing when the available version already matches dismissedVersion', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('check', available);
    fixture.componentRef.setInput('dismissedVersion', '0.4.0');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.update-banner')).toBeNull();
  });

  it('renders the available version and notes when not dismissed', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('check', available);
    fixture.detectChanges();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Myna 0.4.0 is available.');
    expect(text).toContain('Faster startup and a fixed crash on import.');
  });

  it('shows the unsigned-build mic-permission caveat by default', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('check', available);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.caveat')).toBeTruthy();
  });

  it('hides the mic-permission caveat when signed is true', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('check', available);
    fixture.componentRef.setInput('signed', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.caveat')).toBeNull();
  });

  it('copies the download link to the clipboard', async () => {
    const writeText = vi.fn(async (text: string) => {
      void text;
    });
    Object.assign(navigator, { clipboard: { writeText } });
    const fixture = createFixture();
    fixture.componentRef.setInput('check', available);
    fixture.detectChanges();

    fixture.nativeElement.querySelector('.copy').click();
    await Promise.resolve();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledWith('https://github.com/example/myna/releases/tag/v0.4.0');
    expect(fixture.nativeElement.querySelector('.copy').textContent).toContain('Copied!');
  });

  it('emits dismissed when the × button is clicked', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('check', available);
    fixture.detectChanges();
    const emitted: void[] = [];
    fixture.componentInstance.dismissed.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.dismiss').click();

    expect(emitted.length).toBe(1);
  });
});
