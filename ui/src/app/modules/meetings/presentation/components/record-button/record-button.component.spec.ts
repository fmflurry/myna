import { TestBed } from '@angular/core/testing';

import { RecordButtonComponent } from './record-button.component';

describe('RecordButtonComponent', () => {
  const create = () => {
    const fixture = TestBed.createComponent(RecordButtonComponent);
    fixture.componentRef.setInput('state', 'idle');
    fixture.detectChanges();
    return fixture;
  };

  it('shows a single Record button when idle', () => {
    const fixture = create();

    const buttons = fixture.nativeElement.querySelectorAll('button');
    expect(buttons.length).toBe(1);
    expect(buttons[0].textContent).toContain('Record');
  });

  it('emits recordClicked when the Record button is clicked', () => {
    const fixture = create();
    const emitted: void[] = [];
    fixture.componentInstance.recordClicked.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('button').click();

    expect(emitted.length).toBe(1);
  });

  it('shows Stop and Cancel buttons while recording', () => {
    const fixture = TestBed.createComponent(RecordButtonComponent);
    fixture.componentRef.setInput('state', 'recording');
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('button');
    expect(buttons.length).toBe(2);
  });

  it('shows a disabled "Preparing…" record button, announced as busy, while the model loads', () => {
    const fixture = TestBed.createComponent(RecordButtonComponent);
    fixture.componentRef.setInput('state', 'idle');
    fixture.componentRef.setInput('startingRecording', true);
    fixture.detectChanges();

    const button: HTMLButtonElement = fixture.nativeElement.querySelector('button');
    expect(button.textContent).toContain('Preparing');
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('shows a disabled "Finalizing…" stop button, announced as busy, while stopping', () => {
    const fixture = TestBed.createComponent(RecordButtonComponent);
    fixture.componentRef.setInput('state', 'stopping');
    fixture.detectChanges();

    const stopButton: HTMLButtonElement = fixture.nativeElement.querySelector('.stop');
    expect(stopButton.textContent).toContain('Finalizing');
    expect(stopButton.disabled).toBe(true);
    expect(stopButton.getAttribute('aria-busy')).toBe('true');
  });
});
