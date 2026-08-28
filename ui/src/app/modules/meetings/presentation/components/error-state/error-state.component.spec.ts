import { TestBed } from '@angular/core/testing';

import { ErrorStateComponent } from './error-state.component';

describe('ErrorStateComponent', () => {
  const createFixture = (code: string) => {
    const fixture = TestBed.createComponent(ErrorStateComponent);
    fixture.componentRef.setInput('code', code);
    fixture.detectChanges();
    return fixture;
  };

  it('shows a human message for a known error code, not the raw message string', () => {
    const fixture = createFixture('MODELS_MISSING');

    expect(fixture.nativeElement.querySelector('.message').textContent).toBe(
      'Required local models are missing.',
    );
  });

  it('falls back to an unknown-error message for an unrecognized code', () => {
    const fixture = createFixture('SOMETHING_NEW');

    expect(fixture.nativeElement.querySelector('.message').textContent).toBe('Something went wrong.');
  });

  it('emits retryClicked when the retry button is clicked', () => {
    const fixture = createFixture('IO');
    const emitted: void[] = [];
    fixture.componentInstance.retryClicked.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.retry').click();

    expect(emitted.length).toBe(1);
  });
});
