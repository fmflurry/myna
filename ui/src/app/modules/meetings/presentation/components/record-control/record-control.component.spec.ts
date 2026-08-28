import { By } from '@angular/platform-browser';
import { TestBed } from '@angular/core/testing';

import type { AudioDevice } from '../../../core/models/audio-device.model';
import type { AudioSource } from '../../../core/models/audio-source.model';
import type { CaptureSource } from '../../../core/models/capture-source.model';
import type { RecordingState } from '../../../core/models/recording-state.model';
import { CaptureSettingsComponent } from '../capture-settings/capture-settings.component';
import { RecordControlComponent } from './record-control.component';

describe('RecordControlComponent', () => {
  const createFixture = (recordingState: RecordingState = 'idle') => {
    const fixture = TestBed.createComponent(RecordControlComponent);
    fixture.componentRef.setInput('recordingState', recordingState);
    fixture.componentRef.setInput('captureSource', 'microphone' satisfies CaptureSource);
    fixture.componentRef.setInput('systemAudioStatus', { kind: 'available' });
    fixture.detectChanges();
    return fixture;
  };

  it('shows the compact capture-settings trigger inline before recording starts, with no title input', () => {
    const fixture = createFixture('idle');

    expect(fixture.nativeElement.querySelector('.title-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('app-capture-settings')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-record-button')).toBeTruthy();
  });

  it('collapses to a compact live indicator and timer while recording', () => {
    const fixture = createFixture('recording');

    expect(fixture.nativeElement.querySelector('.title-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.live-indicator')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('.timer')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('app-level-meter')).toBeTruthy();
  });

  it('relays deviceChanged from the capture-settings child', () => {
    const fixture = createFixture('idle');
    fixture.componentRef.setInput('devices', [{ name: 'Built-in Microphone' } satisfies AudioDevice]);
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.deviceChanged.subscribe((value) => emitted.push(value));

    const captureSettings = fixture.debugElement.query(By.directive(CaptureSettingsComponent));
    (captureSettings.componentInstance as CaptureSettingsComponent).deviceChanged.emit('Built-in Microphone');

    expect(emitted).toEqual(['Built-in Microphone']);
  });

  it('relays sourceSelected and permissionRequested from the capture-settings child', () => {
    const fixture = createFixture('idle');
    fixture.detectChanges();
    const emittedSources: CaptureSource[] = [];
    const permissionRequests: void[] = [];
    fixture.componentInstance.sourceSelected.subscribe((value) => emittedSources.push(value));
    fixture.componentInstance.permissionRequested.subscribe(() => permissionRequests.push(undefined));

    const captureSettings = fixture.debugElement.query(By.directive(CaptureSettingsComponent))
      .componentInstance as CaptureSettingsComponent;
    captureSettings.sourceSelected.emit('mixed');
    captureSettings.permissionRequested.emit();

    expect(emittedSources).toEqual(['mixed']);
    expect(permissionRequests.length).toBe(1);
  });

  it('forwards record/stop/cancel clicks from the record button', () => {
    const fixture = createFixture('idle');
    const recordClicks: void[] = [];
    fixture.componentInstance.recordClicked.subscribe(() => recordClicks.push(undefined));

    fixture.nativeElement.querySelector('app-record-button button').click();

    expect(recordClicks.length).toBe(1);
  });

  it('disables the capture-settings trigger when disabled', () => {
    const fixture = TestBed.createComponent(RecordControlComponent);
    fixture.componentRef.setInput('recordingState', 'idle' satisfies RecordingState);
    fixture.componentRef.setInput('captureSource', 'microphone' satisfies CaptureSource);
    fixture.componentRef.setInput('systemAudioStatus', { kind: 'available' });
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    const captureSettings = fixture.debugElement.query(By.directive(CaptureSettingsComponent))
      .componentInstance as CaptureSettingsComponent;
    expect(captureSettings.disabled()).toBe(true);
  });

  it('relays audioSourceSelected from the capture-settings child', () => {
    const fixture = createFixture('idle');
    fixture.detectChanges();
    const emitted: string[] = [];
    fixture.componentInstance.audioSourceSelected.subscribe((value) => emitted.push(value));

    const captureSettings = fixture.debugElement.query(By.directive(CaptureSettingsComponent))
      .componentInstance as CaptureSettingsComponent;
    captureSettings.audioSourceSelected.emit('app:teams');

    expect(emitted).toEqual(['app:teams']);
  });

  it('shows the effective system-audio source while recording', () => {
    const fixture = createFixture('recording');
    const source: AudioSource = { id: 'app:teams', name: 'Teams' };
    fixture.componentRef.setInput('effectiveSystemSource', source);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.effective-source').textContent).toContain('Teams');
  });

  it('shows nothing for the effective source while recording microphone-only', () => {
    const fixture = createFixture('recording');
    fixture.componentRef.setInput('effectiveSystemSource', null);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.effective-source')).toBeNull();
    expect(fixture.nativeElement.querySelector('.degraded-source')).toBeNull();
  });

  it('surfaces a silent fallback to mic-only when "Both" was requested but no system source took effect', () => {
    const fixture = createFixture('recording');
    fixture.componentRef.setInput('captureSource', 'mixed' satisfies CaptureSource);
    fixture.componentRef.setInput('effectiveSystemSource', null);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.effective-source')).toBeNull();
    expect(fixture.nativeElement.querySelector('.degraded-source')?.textContent).toContain('Mic only');
  });

  it('surfaces a silent fallback to mic-only when "System only" was requested but no system source took effect', () => {
    const fixture = createFixture('recording');
    fixture.componentRef.setInput('captureSource', 'system' satisfies CaptureSource);
    fixture.componentRef.setInput('effectiveSystemSource', null);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.degraded-source')?.textContent).toContain('Mic only');
  });

  it('shows an accessible "preparing" status and disables capture settings while the model loads', () => {
    const fixture = createFixture('idle');
    fixture.componentRef.setInput('startingRecording', true);
    fixture.detectChanges();

    const status = fixture.nativeElement.querySelector('.preparing');
    expect(status).toBeTruthy();
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-busy')).toBe('true');

    const captureSettings = fixture.debugElement.query(By.directive(CaptureSettingsComponent))
      .componentInstance as CaptureSettingsComponent;
    expect(captureSettings.disabled()).toBe(true);
  });

  it('shows an accessible "finalizing" status while stopping, instead of the live recording controls', () => {
    const fixture = createFixture('stopping');

    const status = fixture.nativeElement.querySelector('.finalizing');
    expect(status).toBeTruthy();
    expect(status.getAttribute('role')).toBe('status');
    expect(status.getAttribute('aria-busy')).toBe('true');
    expect(fixture.nativeElement.querySelector('.live-indicator')).toBeNull();
  });
});
