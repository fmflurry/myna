import { TestBed } from '@angular/core/testing';

import { UpdateConsentDialogComponent } from './update-consent-dialog.component';

describe('UpdateConsentDialogComponent', () => {
  const createFixture = () => {
    const fixture = TestBed.createComponent(UpdateConsentDialogComponent);
    fixture.detectChanges();
    return fixture;
  };

  it('shows the unsigned-build mic caveat by default (signed defaults to false)', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.caveat')).toBeTruthy();
  });

  it('hides the unsigned-build mic caveat when signed is true', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('signed', true);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.caveat')).toBeNull();
  });

  it('always shows the About > Updates footer note', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.footer').textContent).toContain('About');
  });

  it('emits granted when "Turn on update checks" is clicked', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.granted.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.grant').click();

    expect(emitted.length).toBe(1);
  });

  it('emits declined when "No thanks" is clicked', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.declined.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.decline').click();

    expect(emitted.length).toBe(1);
  });

  it('emits postponed when the close (×) button is clicked', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.postponed.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.close').click();

    expect(emitted.length).toBe(1);
  });

  it('emits postponed when Escape is pressed', () => {
    const fixture = createFixture();
    const emitted: void[] = [];
    fixture.componentInstance.postponed.subscribe(() => emitted.push(undefined));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(emitted.length).toBe(1);
    fixture.destroy();
  });

  it('emits neither granted nor declined when postponed', () => {
    const fixture = createFixture();
    const grantedCalls: void[] = [];
    const declinedCalls: void[] = [];
    fixture.componentInstance.granted.subscribe(() => grantedCalls.push(undefined));
    fixture.componentInstance.declined.subscribe(() => declinedCalls.push(undefined));

    fixture.nativeElement.querySelector('.close').click();

    expect(grantedCalls.length).toBe(0);
    expect(declinedCalls.length).toBe(0);
  });
});
