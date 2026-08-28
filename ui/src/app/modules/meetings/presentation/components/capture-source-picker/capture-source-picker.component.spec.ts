import { TestBed } from '@angular/core/testing';

import type { SystemAudioStatus } from '../../../core/models/capture-source.model';
import { CaptureSourcePickerComponent } from './capture-source-picker.component';

describe('CaptureSourcePickerComponent', () => {
  const AVAILABLE: SystemAudioStatus = { kind: 'available' };

  const createFixture = (status: SystemAudioStatus = AVAILABLE) => {
    const fixture = TestBed.createComponent(CaptureSourcePickerComponent);
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('systemAudioStatus', status);
    fixture.detectChanges();
    return fixture;
  };

  it('renders one button per capture source option', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelectorAll('.source').length).toBe(3);
  });

  it('marks the currently selected option as pressed', () => {
    const fixture = TestBed.createComponent(CaptureSourcePickerComponent);
    fixture.componentRef.setInput('captureSource', 'mixed');
    fixture.componentRef.setInput('systemAudioStatus', AVAILABLE);
    fixture.detectChanges();

    const selected = fixture.nativeElement.querySelector('.selected');
    expect(selected.textContent).toContain('Both');
  });

  it('emits sourceSelected when an enabled option is clicked', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.sourceSelected.subscribe((source) => emitted.push(source));

    fixture.nativeElement.querySelectorAll('.source')[1].click();

    expect(emitted).toEqual(['system']);
  });

  it('keeps system and mixed options enabled and selectable when system audio status is unknown, and shows no reason', () => {
    const fixture = createFixture({ kind: 'unknown' });

    const [mic, system, mixed] = fixture.nativeElement.querySelectorAll('.source');
    expect(mic.disabled).toBe(false);
    expect(system.disabled).toBe(false);
    expect(mixed.disabled).toBe(false);
    expect(fixture.nativeElement.querySelector('.reason')).toBeNull();
    expect(fixture.nativeElement.querySelector('.grant-permission')).toBeNull();
  });

  it('emits sourceSelected for "Both" when the status is unknown — this is what lets the OS prompt appear', () => {
    const fixture = createFixture({ kind: 'unknown' });
    const emitted: string[] = [];
    fixture.componentInstance.sourceSelected.subscribe((source) => emitted.push(source));

    fixture.nativeElement.querySelectorAll('.source')[2].click();

    expect(emitted).toEqual(['mixed']);
  });

  it('disables system and mixed options when system audio is unavailable, and shows the reason', () => {
    const fixture = createFixture({ kind: 'unavailable', reason: 'No loopback device found.' });

    const [mic, system, mixed] = fixture.nativeElement.querySelectorAll('.source');
    expect(mic.disabled).toBe(false);
    expect(system.disabled).toBe(true);
    expect(mixed.disabled).toBe(true);
    expect(fixture.nativeElement.querySelector('.reason')?.textContent).toBe(
      'No loopback device found.'
    );
  });

  it('does not emit sourceSelected when clicking a disabled option', () => {
    const fixture = createFixture({ kind: 'unavailable', reason: 'No loopback device found.' });
    const emitted: string[] = [];
    fixture.componentInstance.sourceSelected.subscribe((source) => emitted.push(source));

    fixture.nativeElement.querySelectorAll('.source')[1].click();

    expect(emitted).toEqual([]);
  });

  it('shows a Grant permission button and emits permissionRequested when clicked', () => {
    const fixture = createFixture({ kind: 'permission_denied', restartRequired: false });
    const emissions: number[] = [];
    fixture.componentInstance.permissionRequested.subscribe(() => emissions.push(1));

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.grant-permission');
    expect(button).toBeTruthy();
    button.click();

    expect(emissions.length).toBe(1);
  });

  it('shows the restart hint when restartRequired is true', () => {
    const fixture = createFixture({ kind: 'permission_denied', restartRequired: true });

    expect(fixture.nativeElement.querySelector('.restart-hint')?.textContent).toContain(
      'Restart Myna'
    );
  });

  it('does not show the restart hint when restartRequired is false', () => {
    const fixture = createFixture({ kind: 'permission_denied', restartRequired: false });

    expect(fixture.nativeElement.querySelector('.restart-hint')).toBeNull();
  });

  it('shows the headphones hint only when the selected source is mixed', () => {
    const fixture = TestBed.createComponent(CaptureSourcePickerComponent);
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('systemAudioStatus', AVAILABLE);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.headphones-hint')).toBeNull();

    fixture.componentRef.setInput('captureSource', 'mixed');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.headphones-hint')?.textContent).toContain(
      'headphones'
    );
  });

  it('disables every option when the disabled input is true', () => {
    const fixture = TestBed.createComponent(CaptureSourcePickerComponent);
    fixture.componentRef.setInput('captureSource', 'microphone');
    fixture.componentRef.setInput('systemAudioStatus', AVAILABLE);
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    const buttons: HTMLButtonElement[] = Array.from(
      fixture.nativeElement.querySelectorAll('.source')
    );
    expect(buttons.every((button) => button.disabled)).toBe(true);
  });
});
