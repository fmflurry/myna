import { TestBed } from '@angular/core/testing';

import type { SummaryLanguage } from '../../../core/models/summary-language.model';
import type { UpdateConsent } from '../../../core/models/update.model';
import { SettingsComponent } from './settings.component';

describe('SettingsComponent', () => {
  const languages: readonly SummaryLanguage[] = [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
  ];

  /** `updateConsent` and `selectedSummaryLanguage` are `input.required` — every fixture sets them before the first `detectChanges()`. */
  const createFixture = (
    updateConsent: UpdateConsent = 'unset',
    summaryLanguages: readonly SummaryLanguage[] = languages,
    selectedSummaryLanguage = 'en',
  ) => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.componentRef.setInput('updateConsent', updateConsent);
    fixture.componentRef.setInput('summaryLanguages', summaryLanguages);
    fixture.componentRef.setInput('selectedSummaryLanguage', selectedSummaryLanguage);
    fixture.detectChanges();
    return fixture;
  };

  it('reflects granted consent as a checked auto-check toggle', () => {
    const fixture = createFixture('granted');

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.auto-check input');
    expect(checkbox.checked).toBe(true);
  });

  it('reflects unset consent as an unchecked auto-check toggle', () => {
    const fixture = createFixture('unset');

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.auto-check input');
    expect(checkbox.checked).toBe(false);
  });

  it('emits granted when the auto-check toggle is switched on', () => {
    const fixture = createFixture('declined');
    const emitted: UpdateConsent[] = [];
    fixture.componentInstance.updateConsentChanged.subscribe((consent) => emitted.push(consent));

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.auto-check input');
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event('change'));

    expect(emitted).toEqual(['granted']);
  });

  it('emits declined when the auto-check toggle is switched off', () => {
    const fixture = createFixture('granted');
    const emitted: UpdateConsent[] = [];
    fixture.componentInstance.updateConsentChanged.subscribe((consent) => emitted.push(consent));

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.auto-check input');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(emitted).toEqual(['declined']);
  });

  it('disables "Check now" while a check is in flight', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('checking', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.check-now').disabled).toBe(true);
  });

  it('disables "Check now" while a recording is in progress', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('recording', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.check-now').disabled).toBe(true);
  });

  it('emits checkNowRequested when "Check now" is clicked', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.checkNowRequested.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.check-now').click();

    expect(emitted.length).toBe(1);
  });

  it('shows "Not this session" for last-checked before any check has run', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.last-checked').textContent).toContain('Not this session');
  });

  it('shows "Just now" for last-checked once a check has run this session', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('lastCheck', { status: 'up-to-date' });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.last-checked').textContent).toContain('Just now');
  });

  it('renders one option per summary language and marks the selected one', () => {
    const fixture = createFixture('unset', languages, 'fr');

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['en', 'fr']);
    expect(select.value).toBe('fr');
  });

  it('emits summaryLanguageSelected with the chosen code', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.summaryLanguageSelected.subscribe((code) => emitted.push(code));

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    select.value = 'fr';
    select.dispatchEvent(new Event('change'));

    expect(emitted).toEqual(['fr']);
  });

  it('disables the language select until the Rust-owned list has loaded', () => {
    const fixture = createFixture('unset', []);

    expect(fixture.nativeElement.querySelector('select').disabled).toBe(true);
  });

  it('emits closed when the close button is clicked', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.closed.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.close').click();

    expect(emitted.length).toBe(1);
  });

  it('seeds the guidelines textarea from the input', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('guidelines', 'Be concise.');
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.guidelines-input');
    expect(textarea.value).toBe('Be concise.');
  });

  it('keeps "Save guidelines" disabled while the textarea matches the saved value', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('guidelines', 'Be concise.');
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('.save-guidelines') as HTMLButtonElement).disabled).toBe(true);

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.guidelines-input');
    textarea.value = 'Be concise. Use bullets.';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect((fixture.nativeElement.querySelector('.save-guidelines') as HTMLButtonElement).disabled).toBe(false);
  });

  it('emits the trimmed value when "Save guidelines" is clicked', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.guidelinesChanged.subscribe((text) => emitted.push(text));

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.guidelines-input');
    textarea.value = '  Focus on decisions.  ';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.save-guidelines').click();

    expect(emitted).toEqual(['Focus on decisions.']);
  });

  it('saves on blur, and never re-emits an unchanged value', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('guidelines', 'Be concise.');
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.guidelinesChanged.subscribe((text) => emitted.push(text));

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.guidelines-input');
    textarea.dispatchEvent(new Event('blur'));
    expect(emitted).toEqual([]);

    textarea.value = 'Be concise. In French.';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new Event('blur'));
    expect(emitted).toEqual(['Be concise. In French.']);
  });

  it('shows the current storage path once loaded', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('storagePath', '/tmp/myna-data');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.storage-path-value').textContent).toContain('/tmp/myna-data');
  });

  it('shows a loading placeholder until the storage location resolves', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.storage-path-value').textContent).toContain('Loading…');
  });

  it('shows the inline storage error, hidden when null', () => {
    const clean = createFixture();
    expect(clean.nativeElement.querySelector('.storage-error')).toBeNull();

    const failed = createFixture();
    failed.componentRef.setInput('storageError', 'not a directory');
    failed.detectChanges();
    expect(failed.nativeElement.querySelector('.storage-error')?.textContent).toContain('not a directory');
  });

  it('shows the restart prompt after a move that needs a restart, hidden otherwise', () => {
    const withoutRestart = createFixture();
    expect(withoutRestart.nativeElement.querySelector('.storage-restart')).toBeNull();

    const withRestart = createFixture();
    withRestart.componentRef.setInput('storageRestartRequired', true);
    withRestart.detectChanges();
    expect(withRestart.nativeElement.querySelector('.storage-restart')?.textContent).toContain('restart');
  });

  it('disables Change/Reset while busy, enables them when idle', () => {
    const busy = createFixture();
    busy.componentRef.setInput('storageBusy', true);
    busy.detectChanges();

    expect((busy.nativeElement.querySelector('.change-storage') as HTMLButtonElement).disabled).toBe(true);
    expect((busy.nativeElement.querySelector('.reset-storage') as HTMLButtonElement).disabled).toBe(true);

    const idle = createFixture();
    expect((idle.nativeElement.querySelector('.change-storage') as HTMLButtonElement).disabled).toBe(false);
    expect((idle.nativeElement.querySelector('.reset-storage') as HTMLButtonElement).disabled).toBe(false);
  });

  it('emits browseStorageRequested on Change… and resetStorageRequested on Reset', () => {
    const fixture = createFixture();
    const browsed: void[] = [];
    const reset: void[] = [];
    fixture.componentInstance.browseStorageRequested.subscribe(() => browsed.push(undefined));
    fixture.componentInstance.resetStorageRequested.subscribe(() => reset.push(undefined));

    fixture.nativeElement.querySelector('.change-storage').click();
    fixture.nativeElement.querySelector('.reset-storage').click();

    expect(browsed.length).toBe(1);
    expect(reset.length).toBe(1);
  });

  it('defaults the Move toggle to checked (Move existing meetings)', () => {
    const fixture = createFixture();

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.storage-move-toggle');
    expect(checkbox.checked).toBe(true);
    expect(fixture.nativeElement.querySelector('.storage-note').textContent).toContain('move');
  });

  it('reflects moveExisting=false as an unchecked Stay toggle with the stay note', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('moveExisting', false);
    fixture.detectChanges();

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.storage-move-toggle');
    expect(checkbox.checked).toBe(false);
    expect(fixture.nativeElement.querySelector('.storage-note').textContent).toContain('stay');
  });

  it('emits moveExistingChanged with the toggled choice', () => {
    const fixture = createFixture();
    const emitted: boolean[] = [];
    fixture.componentInstance.moveExistingChanged.subscribe((choice) => emitted.push(choice));

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.storage-move-toggle');
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));

    expect(emitted).toEqual([false]);
  });

  it('emits browseStorageRequested with the pending Move choice (true by default)', () => {
    const fixture = createFixture();
    const emitted: boolean[] = [];
    fixture.componentInstance.browseStorageRequested.subscribe((choice) => emitted.push(choice));

    fixture.nativeElement.querySelector('.change-storage').click();

    expect(emitted).toEqual([true]);
  });

  it('emits browseStorageRequested/resetStorageRequested with the Stay choice when toggled off', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('moveExisting', false);
    fixture.detectChanges();
    const browsed: boolean[] = [];
    const reset: boolean[] = [];
    fixture.componentInstance.browseStorageRequested.subscribe((choice) => browsed.push(choice));
    fixture.componentInstance.resetStorageRequested.subscribe((choice) => reset.push(choice));

    fixture.nativeElement.querySelector('.change-storage').click();
    fixture.nativeElement.querySelector('.reset-storage').click();

    expect(browsed).toEqual([false]);
    expect(reset).toEqual([false]);
  });
});
