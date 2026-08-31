import { TestBed } from '@angular/core/testing';

import { EditableSegmentComponent } from './editable-segment.component';

describe('EditableSegmentComponent', () => {
  const createFixture = (text: string, editable = true) => {
    const fixture = TestBed.createComponent(EditableSegmentComponent);
    fixture.componentRef.setInput('text', text);
    fixture.componentRef.setInput('editable', editable);
    fixture.detectChanges();
    return fixture;
  };

  /**
   * jsdom always reports `scrollHeight` as 0, so shadow the inherited getter
   * with a fixed value to simulate a textarea whose content needs that many
   * pixels. Restored in `afterEach`.
   */
  const mockScrollHeight = (value: number) => {
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
      value,
      configurable: true,
    });
  };

  afterEach(() => {
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: unknown }).scrollHeight;
  });

  it('displays the text as a native button trigger, not a div or contenteditable, so it stays keyboard-reachable', () => {
    const fixture = createFixture('Welcome everyone');

    expect(fixture.nativeElement.querySelector('.segment-input')).toBeNull();
    const trigger: HTMLElement = fixture.nativeElement.querySelector('.segment-trigger');
    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('type')).toBe('button');
    expect(trigger.textContent!.trim()).toBe('Welcome everyone');
  });

  it('becomes a textarea, pre-filled with the current text and carrying an aria-label, when the trigger is clicked', () => {
    const fixture = createFixture('Welcome everyone');

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    expect(textarea).not.toBeNull();
    expect(textarea.value).toBe('Welcome everyone');
    expect(textarea.getAttribute('aria-label')).toBeTruthy();
  });

  it('focuses the textarea immediately after entering edit mode', async () => {
    const fixture = createFixture('Welcome everyone');
    document.body.appendChild(fixture.nativeElement);

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    expect(document.activeElement).toBe(textarea);

    fixture.nativeElement.remove();
  });

  it('emits textChanged with the trimmed value and exits edit mode on Enter, without inserting a newline', () => {
    const fixture = createFixture('Welcome everyone');
    const emitted: string[] = [];
    fixture.componentInstance.textChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    textarea.value = '  Welcome everybody  ';
    textarea.dispatchEvent(new Event('input'));
    const keydown = new KeyboardEvent('keydown', { key: 'Enter', cancelable: true });
    textarea.dispatchEvent(keydown);
    fixture.detectChanges();

    expect(emitted).toEqual(['Welcome everybody']);
    expect(keydown.defaultPrevented).toBe(true);
    expect(fixture.nativeElement.querySelector('.segment-input')).toBeNull();
    expect(fixture.nativeElement.querySelector('.segment-trigger')).not.toBeNull();
  });

  it('commits on blur, same as Enter', () => {
    const fixture = createFixture('Welcome everyone');
    const emitted: string[] = [];
    fixture.componentInstance.textChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    textarea.value = 'Welcome everybody';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new Event('blur'));
    fixture.detectChanges();

    expect(emitted).toEqual(['Welcome everybody']);
  });

  it('emits nothing, exits edit mode, and restores the original text on Escape', () => {
    const fixture = createFixture('Welcome everyone');
    const emitted: string[] = [];
    fixture.componentInstance.textChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    textarea.value = 'Something else entirely';
    textarea.dispatchEvent(new Event('input'));
    const keydown = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    textarea.dispatchEvent(keydown);
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(keydown.defaultPrevented).toBe(true);
    expect(fixture.nativeElement.querySelector('.segment-trigger').textContent.trim()).toBe('Welcome everyone');
  });

  it('does not emit and restores the original text when the draft is whitespace-only', () => {
    const fixture = createFixture('Welcome everyone');
    const emitted: string[] = [];
    fixture.componentInstance.textChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    textarea.value = '   ';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.segment-trigger').textContent.trim()).toBe('Welcome everyone');
  });

  it('does not emit when the committed draft is unchanged from the current text', () => {
    const fixture = createFixture('Welcome everyone');
    const emitted: string[] = [];
    fixture.componentInstance.textChanged.subscribe((value) => emitted.push(value));

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    textarea.value = '  Welcome everyone  ';
    textarea.dispatchEvent(new Event('input'));
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    fixture.detectChanges();

    expect(emitted).toEqual([]);
  });

  it('renders a plain span with no button and no textarea when editable is false', () => {
    const fixture = createFixture('Welcome everyone', false);

    expect(fixture.nativeElement.querySelector('.segment-trigger')).toBeNull();
    expect(fixture.nativeElement.querySelector('.segment-input')).toBeNull();
    const span: HTMLElement = fixture.nativeElement.querySelector('.segment-text');
    expect(span).not.toBeNull();
    expect(span.tagName).toBe('SPAN');
    expect(span.textContent!.trim()).toBe('Welcome everyone');
  });

  it('sizes the textarea to fit the entire draft text when editing starts', async () => {
    mockScrollHeight(96);
    const fixture = createFixture(
      'A long transcript segment that wraps across many rendered lines at the section width',
    );
    document.body.appendChild(fixture.nativeElement);

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    expect(textarea.style.height).toBe('96px');

    fixture.nativeElement.remove();
  });

  it('re-adjusts the textarea height as the draft changes on input', async () => {
    mockScrollHeight(96);
    const fixture = createFixture('Initial text');
    document.body.appendChild(fixture.nativeElement);

    const trigger: HTMLButtonElement = fixture.nativeElement.querySelector('.segment-trigger');
    trigger.click();
    fixture.detectChanges();
    await fixture.whenStable();

    const textarea: HTMLTextAreaElement = fixture.nativeElement.querySelector('.segment-input');
    expect(textarea.style.height).toBe('96px');

    mockScrollHeight(140);
    textarea.value = 'Initial text extended with much more content that now needs additional lines';
    textarea.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(textarea.style.height).toBe('140px');

    fixture.nativeElement.remove();
  });
});
