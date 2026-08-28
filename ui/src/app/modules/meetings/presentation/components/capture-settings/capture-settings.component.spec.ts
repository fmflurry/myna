import { TestBed } from '@angular/core/testing';

import type { AudioDevice } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource } from '../../../core/models/capture-source.model';
import { CaptureSettingsComponent } from './capture-settings.component';

const AUDIO_SOURCES: readonly AudioSource[] = [
  { id: 'system:all', name: 'All system audio' },
  { id: 'app:teams', name: 'Teams' },
];

describe('CaptureSettingsComponent', () => {
  const createFixture = (captureSource: CaptureSource = 'microphone') => {
    const fixture = TestBed.createComponent(CaptureSettingsComponent);
    fixture.componentRef.setInput('captureSource', captureSource);
    fixture.componentRef.setInput('systemAudioStatus', { kind: 'available' });
    fixture.detectChanges();
    return fixture;
  };

  it('shows a short-form trigger reflecting the current capture source and no popover initially', () => {
    const fixture = createFixture('microphone');

    expect(fixture.nativeElement.querySelector('.trigger').textContent).toContain('Mic');
    expect(fixture.nativeElement.querySelector('.popover')).toBeNull();
  });

  it('shows "Mic + System" for the mixed source', () => {
    const fixture = createFixture('mixed');

    expect(fixture.nativeElement.querySelector('.trigger').textContent).toContain('Mic + System');
  });

  it('opens the popover with the device select and source picker when the trigger is clicked', () => {
    const fixture = createFixture();

    fixture.nativeElement.querySelector('.trigger').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.popover')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.device-select')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-capture-source-picker')).toBeTruthy();
  });

  it('emits deviceChanged when the microphone select changes', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('devices', [{ name: 'Built-in Microphone' } satisfies AudioDevice]);
    fixture.nativeElement.querySelector('.trigger').click();
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.deviceChanged.subscribe((value) => emitted.push(value));

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('.device-select');
    select.value = 'Built-in Microphone';
    select.dispatchEvent(new Event('change'));

    expect(emitted).toEqual(['Built-in Microphone']);
  });

  it('emits sourceSelected and closes the popover when a source is picked', () => {
    const fixture = createFixture();
    fixture.nativeElement.querySelector('.trigger').click();
    fixture.detectChanges();
    const emitted: CaptureSource[] = [];
    fixture.componentInstance.sourceSelected.subscribe((value) => emitted.push(value));

    const sourceButton: HTMLButtonElement = fixture.nativeElement.querySelector(
      'app-capture-source-picker .source',
    );
    sourceButton.click();
    fixture.detectChanges();

    expect(emitted.length).toBe(1);
    expect(fixture.nativeElement.querySelector('.popover')).toBeNull();
  });

  it('disables the trigger when disabled is set', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.trigger');
    expect(trigger.disabled).toBe(true);
  });

  it('renders the system-audio source select next to the microphone select', () => {
    const fixture = createFixture('mixed');
    fixture.componentRef.setInput('audioSources', AUDIO_SOURCES);
    fixture.nativeElement.querySelector('.trigger').click();
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('.audio-source-select');
    expect(select).toBeTruthy();
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['system:all', 'app:teams']);
  });

  it('disables the system-audio source select when the capture source is microphone-only', () => {
    const fixture = createFixture('microphone');
    fixture.componentRef.setInput('audioSources', AUDIO_SOURCES);
    fixture.nativeElement.querySelector('.trigger').click();
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('.audio-source-select');
    expect(select.disabled).toBe(true);
  });

  it('disables the microphone select when the capture source is system-only', () => {
    const fixture = createFixture('system');
    fixture.nativeElement.querySelector('.trigger').click();
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('.device-select');
    expect(select.disabled).toBe(true);
  });

  it('emits audioSourceSelected when the system-audio source select changes', () => {
    const fixture = createFixture('mixed');
    fixture.componentRef.setInput('audioSources', AUDIO_SOURCES);
    fixture.nativeElement.querySelector('.trigger').click();
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.audioSourceSelected.subscribe((value) => emitted.push(value));

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('.audio-source-select');
    select.value = 'app:teams';
    select.dispatchEvent(new Event('change'));

    expect(emitted).toEqual(['app:teams']);
  });

  it('shows the specific selected app name in the trigger for a system-only source', () => {
    const fixture = createFixture('system');
    fixture.componentRef.setInput('audioSources', AUDIO_SOURCES);
    fixture.componentRef.setInput('selectedAudioSource', 'app:teams');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.trigger').textContent).toContain('Teams');
  });

  it('shows "Mic only" in the trigger for the microphone-only source', () => {
    const fixture = createFixture('microphone');

    expect(fixture.nativeElement.querySelector('.trigger').textContent).toContain('Mic only');
  });
});
