import { TestBed } from '@angular/core/testing';

import { EditableTitleComponent } from './editable-title.component';

describe('EditableTitleComponent', () => {
  const createFixture = (title: string) => {
    const fixture = TestBed.createComponent(EditableTitleComponent);
    fixture.componentRef.setInput('title', title);
    fixture.detectChanges();
    return fixture;
  };

  it('displays the title as plain text initially', () => {
    const fixture = createFixture('Weekly sync');

    expect(fixture.nativeElement.querySelector('.title-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.title-trigger').textContent.trim()).toBe('Weekly sync');
  });

  it('renders the trigger as a native button so it is reachable and operable by keyboard, not click-only', () => {
    const fixture = createFixture('Weekly sync');

    const trigger: HTMLElement = fixture.nativeElement.querySelector('.title-trigger');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');
  });

  it('becomes an input, pre-filled with the current title, when the trigger is clicked', () => {
    const fixture = createFixture('Weekly sync');

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.title-trigger');
    trigger.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.title-input');
    expect(input).not.toBeNull();
    expect(input.value).toBe('Weekly sync');
  });

  it('focuses the input immediately after entering edit mode', async () => {
    const fixture = createFixture('Weekly sync');
    document.body.appendChild(fixture.nativeElement);

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.title-trigger');
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.title-input');
    expect(document.activeElement).toBe(input);

    fixture.nativeElement.remove();
  });

  it('emits titleChanged with the trimmed value and exits edit mode on Enter', () => {
    const fixture = createFixture('Weekly sync');
    const emitted: string[] = [];
    fixture.componentInstance.titleChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.title-trigger');
    trigger.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.title-input');
    input.value = '  Roadmap planning  ';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual(['Roadmap planning']);
    expect(fixture.nativeElement.querySelector('.title-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.title-trigger')).not.toBeNull();
  });

  it('commits on blur, same as Enter', () => {
    const fixture = createFixture('Weekly sync');
    const emitted: string[] = [];
    fixture.componentInstance.titleChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.title-trigger');
    trigger.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.title-input');
    input.value = 'Roadmap planning';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(emitted).toEqual(['Roadmap planning']);
  });

  it('restores the original title and does not emit when Escape is pressed', () => {
    const fixture = createFixture('Weekly sync');
    const emitted: string[] = [];
    fixture.componentInstance.titleChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.title-trigger');
    trigger.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.title-input');
    input.value = 'Something else entirely';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.title-trigger').textContent.trim()).toBe('Weekly sync');
  });

  it('does not emit when the committed value is unchanged from the current title', () => {
    const fixture = createFixture('Weekly sync');
    const emitted: string[] = [];
    fixture.componentInstance.titleChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.title-trigger');
    trigger.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.title-input');
    input.value = '  Weekly sync  ';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
  });

  it('does not emit when the trimmed value is empty', () => {
    const fixture = createFixture('Weekly sync');
    const emitted: string[] = [];
    fixture.componentInstance.titleChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.title-trigger');
    trigger.click();
    fixture.detectChanges();

    const input: HTMLInputElement = fixture.nativeElement.querySelector('.title-input');
    input.value = '   ';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
  });
});
