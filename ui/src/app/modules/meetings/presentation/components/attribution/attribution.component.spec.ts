import { TestBed } from '@angular/core/testing';

import { AttributionComponent } from './attribution.component';

describe('AttributionComponent', () => {
  /** `updateConsent` is `input.required` — every fixture must set it before the first `detectChanges()`. */
  const createFixture = (updateConsent: 'unset' | 'granted' | 'declined' = 'unset') => {
    const fixture = TestBed.createComponent(AttributionComponent);
    fixture.componentRef.setInput('updateConsent', updateConsent);
    fixture.detectChanges();
    return fixture;
  };

  it('lists the licence obligations for every embedded model and runtime', () => {
    const fixture = createFixture();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Parakeet-TDT weights');
    expect(text).toContain('CC-BY-4.0');
    expect(text).toContain('sherpa-onnx');
    expect(text).toContain('Apache-2.0');
    expect(text).toContain('llama.cpp');
    expect(text).toContain('MIT');
    expect(text).toContain('Myna');
    expect(text).toContain('Poppins & Inter');
    expect(text).toContain('SIL Open Font License 1.1');
  });

  it('shows the app version when provided', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('version', '0.3.1');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.version').textContent).toContain('0.3.1');
  });

  it('omits the version line when no version has been loaded yet', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.version')).toBeNull();
  });

  it('emits closed when the close button is clicked', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.closed.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.close').click();

    expect(emitted.length).toBe(1);
  });

  it('reflects granted consent as a checked auto-check checkbox', () => {
    const fixture = createFixture('granted');

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.auto-check input');
    expect(checkbox.checked).toBe(true);
  });

  it('reflects unset/declined consent as an unchecked auto-check checkbox', () => {
    const fixture = createFixture('unset');

    const checkbox: HTMLInputElement = fixture.nativeElement.querySelector('.auto-check input');
    expect(checkbox.checked).toBe(false);
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

  it('shows "Never" for last-checked before any check has run', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.last-checked').textContent).toContain('Never');
  });
});
