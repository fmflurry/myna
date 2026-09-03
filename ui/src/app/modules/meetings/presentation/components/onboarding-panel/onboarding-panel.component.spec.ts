import { TestBed } from '@angular/core/testing';

import type { ModelDownloadState } from '../../../application/stores/meetings.store';
import type { ModelsStatus } from '../../../core/models/models-status.model';
import { OnboardingPanelComponent } from './onboarding-panel.component';

describe('OnboardingPanelComponent', () => {
  const createFixture = (status?: ModelsStatus, modelDownload?: ModelDownloadState) => {
    const fixture = TestBed.createComponent(OnboardingPanelComponent);
    if (status) {
      fixture.componentRef.setInput('status', status);
    }
    if (modelDownload) {
      fixture.componentRef.setInput('modelDownload', modelDownload);
    }
    fixture.detectChanges();
    return fixture;
  };

  const notReady: ModelsStatus = {
    parakeet: { present: false, expectedFiles: ['encoder.int8.onnx'] },
    qwen: { present: true, expectedFiles: ['model.gguf'] },
    silero: { present: true, expectedFiles: ['silero_vad.onnx'] },
    allPresent: false,
  };

  it('shows a checking message while status is unknown', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.textContent).toContain('Checking installed models');
  });

  it('lists every expected model file sourced from ModelsStatus', () => {
    const fixture = createFixture(notReady);

    const items: HTMLElement[] = Array.from(fixture.nativeElement.querySelectorAll('li'));
    expect(items.map((el) => el.textContent?.trim())).toContain('✗encoder.int8.onnx');
    expect(items.some((el) => el.classList.contains('present'))).toBe(true);
  });

  it('emits recheckRequested when the recheck button is clicked', () => {
    const fixture = createFixture(notReady);
    const emitted: void[] = [];
    fixture.componentInstance.recheckRequested.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.recheck').click();

    expect(emitted.length).toBe(1);
  });

  it('never shows shell commands, script paths, or a copy button', () => {
    const fixture = createFixture(notReady);

    expect(fixture.nativeElement.textContent).not.toContain('download-models.sh');
    expect(fixture.nativeElement.textContent).not.toContain('./scripts/');
    expect(fixture.nativeElement.querySelector('.copy-download-command')).toBeNull();
    expect(fixture.nativeElement.querySelector('.download')).toBeNull();
  });

  it('explains the download in plain, human language', () => {
    const fixture = createFixture(notReady);
    const text: string = fixture.nativeElement.textContent;

    expect(text).toContain('get your AI models');
    expect(text).toContain('nothing is ever sent to the cloud');
    expect(text).toContain('Download models');
    // The download is ~5.4 GB — copy must not minimize it.
    expect(text).not.toContain('small AI models');
  });

  it('shows a Download models button when idle and emits downloadRequested when clicked', () => {
    const fixture = createFixture(notReady);
    const emitted: void[] = [];
    fixture.componentInstance.downloadRequested.subscribe(() => emitted.push(undefined));

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('.start-download');
    expect(button).toBeTruthy();
    button.click();

    expect(emitted.length).toBe(1);
  });

  it('renders progress and a Cancel button while downloading, and emits downloadCancelRequested when clicked', () => {
    const running: ModelDownloadState = {
      phase: 'running',
      artifact: 'encoder.int8.onnx',
      index: 0,
      total: 3,
      success: false,
      cancelled: false,
      message: null,
    };
    const fixture = createFixture(notReady, running);
    const emitted: void[] = [];
    fixture.componentInstance.downloadCancelRequested.subscribe(() => emitted.push(undefined));

    expect(fixture.nativeElement.querySelector('.start-download')).toBeNull();
    const progress = fixture.nativeElement.querySelector('.download-progress');
    expect(progress.textContent).toContain('encoder.int8.onnx');
    expect(progress.textContent).toContain('1 of 3');
    // Static guidance must live OUTSIDE the aria-live region, or every
    // progress tick re-announces it to screen readers.
    expect(progress.textContent).not.toContain('Please keep Myna open');
    const hint: HTMLElement = fixture.nativeElement.querySelector('.download-hint');
    expect(hint.textContent).toContain('Please keep Myna open until it finishes.');
    expect(hint.getAttribute('role')).toBeNull();
    expect(hint.closest('[aria-live]')).toBeNull();

    const cancelButton: HTMLButtonElement = fixture.nativeElement.querySelector('.cancel-download');
    expect(cancelButton).toBeTruthy();
    cancelButton.click();

    expect(emitted.length).toBe(1);
  });

  it('tells the user what to do and keeps the real backend detail when the download fails', () => {
    const failed: ModelDownloadState = {
      phase: 'failed',
      artifact: 'encoder.int8.onnx',
      index: 0,
      total: 3,
      success: false,
      cancelled: false,
      message: 'Network error downloading encoder.int8.onnx',
    };
    const fixture = createFixture(notReady, failed);

    const error = fixture.nativeElement.querySelector('.download-error');
    expect(error.textContent).toContain('Download failed. Check your internet connection and try again.');
    expect(error.querySelector('.download-error-detail').textContent).toContain(
      'Network error downloading encoder.int8.onnx',
    );
    expect(fixture.nativeElement.querySelector('.start-download')).toBeTruthy();
  });

  it('still shows retry guidance when the failure carries no backend message', () => {
    const failed: ModelDownloadState = {
      phase: 'failed',
      artifact: null,
      index: 0,
      total: 3,
      success: false,
      cancelled: false,
      message: null,
    };
    const fixture = createFixture(notReady, failed);

    const error = fixture.nativeElement.querySelector('.download-error');
    expect(error.textContent).toContain('Download failed. Check your internet connection and try again.');
    expect(error.querySelector('.download-error-detail')).toBeNull();
  });
});
