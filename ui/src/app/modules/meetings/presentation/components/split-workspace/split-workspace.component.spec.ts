import { TestBed } from '@angular/core/testing';

import { SplitWorkspaceComponent } from './split-workspace.component';

/** Fixed container geometry every drag/keydown test measures against. */
const CONTAINER_WIDTH = 1000;

describe('SplitWorkspaceComponent', () => {
  const createFixture = () => {
    const fixture = TestBed.createComponent(SplitWorkspaceComponent);
    fixture.detectChanges();
    const container: HTMLElement = fixture.nativeElement.querySelector('.split-workspace');
    container.getBoundingClientRect = () =>
      ({ left: 0, right: CONTAINER_WIDTH, width: CONTAINER_WIDTH, top: 0, bottom: 0, height: 0 }) as DOMRect;
    return fixture;
  };

  /**
   * jsdom doesn't implement the `PointerEvent` constructor, so a plain
   * `MouseEvent` stands in for it — the component only reads `clientX` and
   * `target`, both of which `MouseEvent` provides identically, and DOM
   * dispatch matches listeners by event TYPE STRING (`'pointerdown'` etc.),
   * not by the event's concrete class.
   */
  const dispatchPointer = (target: EventTarget, type: string, clientX: number): void => {
    target.dispatchEvent(new MouseEvent(type, { clientX, bubbles: true, cancelable: true }));
  };

  it('defaults the transcript column to the default split ratio', () => {
    const fixture = createFixture();

    const leftPane: HTMLElement = fixture.nativeElement.querySelector('.pane-left');
    expect(leftPane.style.width).toBe('40%');
  });

  it('dragging the divider changes the split, and reports the final ratio once the drag ends', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.splitRatioChanged.subscribe((ratio) => emitted.push(ratio));
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    dispatchPointer(divider, 'pointerdown', 400);
    dispatchPointer(window, 'pointermove', 600);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pane-left').style.width).toBe('60%');
    expect(emitted).toEqual([]);

    dispatchPointer(window, 'pointerup', 600);
    fixture.detectChanges();

    expect(emitted).toEqual([0.6]);
  });

  it('enforces a minimum ratio on each side, refusing to collapse either column into unusability', () => {
    const fixture = createFixture();
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    dispatchPointer(divider, 'pointerdown', 400);
    dispatchPointer(window, 'pointermove', -500);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pane-left').style.width).toBe('25%');

    dispatchPointer(window, 'pointermove', 5000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pane-left').style.width).toBe('75%');

    dispatchPointer(window, 'pointerup', 5000);
  });

  it('arrow keys resize a focused divider and emit the new ratio immediately', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.splitRatioChanged.subscribe((ratio) => emitted.push(ratio));
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([0.42]);
    expect(fixture.nativeElement.querySelector('.pane-left').style.width).toBe('42%');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([0.42, 0.4]);
  });

  it('ignores non-arrow keys on the divider', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.splitRatioChanged.subscribe((ratio) => emitted.push(ratio));
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(emitted).toEqual([]);
  });

  it('exposes the divider as a WAI-ARIA vertical separator with the current ratio', () => {
    const fixture = createFixture();

    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.getAttribute('aria-valuenow')).toBe('40');
    expect(divider.getAttribute('tabindex')).toBe('0');
  });

  it('collapsing hides the transcript pane and leaves a reopen affordance in its place', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.pane-left')).toBeTruthy();

    const toggle: HTMLButtonElement = fixture.nativeElement.querySelector('.collapse-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    toggle.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pane-left')).toBeNull();
    const collapsedToggle: HTMLButtonElement = fixture.nativeElement.querySelector('.collapse-toggle');
    expect(collapsedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(collapsedToggle.getAttribute('aria-label')).toContain('Show');
  });

  it('emits collapsedChanged on toggle', () => {
    const fixture = createFixture();
    const emitted: boolean[] = [];
    fixture.componentInstance.collapsedChanged.subscribe((value) => emitted.push(value));

    fixture.nativeElement.querySelector('.collapse-toggle').click();
    fixture.detectChanges();

    expect(emitted).toEqual([true]);
  });

  it('reopening restores the PREVIOUS ratio, not a default, after a drag then a collapse/expand cycle', () => {
    const fixture = createFixture();
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');
    dispatchPointer(divider, 'pointerdown', 400);
    dispatchPointer(window, 'pointermove', 650);
    dispatchPointer(window, 'pointerup', 650);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pane-left').style.width).toBe('65%');

    fixture.nativeElement.querySelector('.collapse-toggle').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.pane-left')).toBeNull();

    fixture.nativeElement.querySelector('.collapse-toggle').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.pane-left').style.width).toBe('65%');
  });

  it('does not start a drag when the pointerdown originates on the collapse toggle', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.splitRatioChanged.subscribe((ratio) => emitted.push(ratio));
    const toggle: HTMLElement = fixture.nativeElement.querySelector('.collapse-toggle');

    dispatchPointer(toggle, 'pointerdown', 700);
    dispatchPointer(window, 'pointermove', 700);
    dispatchPointer(window, 'pointerup', 700);
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.pane-left').style.width).toBe('40%');
  });
});
