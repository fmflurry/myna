import { TestBed } from '@angular/core/testing';

import { WelcomePanelComponent } from './welcome-panel.component';

/**
 * RED spec for a not-yet-existing component. The import above is expected
 * to fail module resolution until `welcome-panel.component.ts` is created —
 * that unresolved-import failure IS the RED signal for this whole file, in
 * addition to each individual assertion below once the file does exist but
 * the behaviour doesn't yet.
 *
 * Intended public API (for the GREEN implementation):
 *   selector: 'app-welcome-panel', standalone, OnPush, templateUrl
 *   input:  startingRecording = input(false)
 *   output: startRecordingRequested = output<void>()
 */
describe('WelcomePanelComponent', () => {
  const createFixture = () => {
    const fixture = TestBed.createComponent(WelcomePanelComponent);
    fixture.detectChanges();
    return fixture;
  };

  it('renders a primary Start a meeting button', () => {
    const fixture = createFixture();

    const button = fixture.nativeElement.querySelector('button.start-meeting');

    expect(button).toBeInstanceOf(HTMLButtonElement);
    expect((button as HTMLButtonElement).type).toBe('button');
    expect((button as HTMLButtonElement).textContent?.trim()).toBe('Start a meeting');
  });

  it('emits startRecordingRequested when the button is clicked', () => {
    const fixture = createFixture();
    let emitCount = 0;
    fixture.componentInstance.startRecordingRequested.subscribe(() => {
      emitCount += 1;
    });

    (fixture.nativeElement.querySelector('button.start-meeting') as HTMLButtonElement).click();

    expect(emitCount).toBe(1);
  });

  it('disables the button and shows a preparing label while startingRecording is true', () => {
    const fixture = TestBed.createComponent(WelcomePanelComponent);
    fixture.componentRef.setInput('startingRecording', true);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('button.start-meeting') as HTMLButtonElement;

    expect(button.disabled).toBe(true);
    expect(button.textContent).toContain('Preparing');
  });

  it('marks the decorative logo aria-hidden', () => {
    const fixture = createFixture();

    const decorativeMark = fixture.nativeElement.querySelector('[aria-hidden="true"]');

    expect(decorativeMark).toBeTruthy();
  });

  it('renders the welcome heading and local-first hint', () => {
    const fixture = createFixture();

    const heading = fixture.nativeElement.querySelector('h1, h2');

    expect(heading?.textContent?.trim()).toBe('Welcome to Myna');
    expect((fixture.nativeElement.textContent as string)).toContain('Everything stays on this device.');
  });
});
