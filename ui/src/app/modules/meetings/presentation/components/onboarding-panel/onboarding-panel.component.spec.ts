import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';

import type { ModelsStatus } from '../../../core/models/models-status.model';
import { OnboardingPanelComponent } from './onboarding-panel.component';

describe('OnboardingPanelComponent', () => {
  const createFixture = (status?: ModelsStatus) => {
    const fixture = TestBed.createComponent(OnboardingPanelComponent);
    if (status) {
      fixture.componentRef.setInput('status', status);
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

  it('copies the download command to the clipboard', async () => {
    const writeText = vi.fn(async (text: string) => {
      void text;
    });
    Object.assign(navigator, { clipboard: { writeText } });
    const fixture = createFixture(notReady);

    await fixture.componentInstance.copyDownloadCommand();
    fixture.detectChanges();

    expect(writeText).toHaveBeenCalledWith('./scripts/download-models.sh');
    expect(fixture.nativeElement.querySelector('.download button').textContent).toContain('Copied!');
  });
});
