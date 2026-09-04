import { TestBed } from '@angular/core/testing';

import { SidebarSplitterComponent } from './sidebar-splitter.component';

/** Fixed container geometry every drag test measures against (sidebar starts at x=0). */
const CONTAINER_WIDTH = 1000;

describe('SidebarSplitterComponent', () => {
  const createFixture = () => {
    const fixture = TestBed.createComponent(SidebarSplitterComponent);
    fixture.detectChanges();
    const container: HTMLElement = fixture.nativeElement.querySelector('.sidebar-splitter');
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

  it('defaults the sidebar to the default width', () => {
    const fixture = createFixture();

    const sidebar: HTMLElement = fixture.nativeElement.querySelector('.sidebar-pane');
    expect(sidebar.style.width).toBe('224px');
  });

  it('dragging the divider changes the width, and reports the final width once the drag ends', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.widthPxChanged.subscribe((width) => emitted.push(width));
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    dispatchPointer(divider, 'pointerdown', 224);
    dispatchPointer(window, 'pointermove', 300);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('300px');
    expect(emitted).toEqual([]);

    dispatchPointer(window, 'pointerup', 300);
    fixture.detectChanges();

    expect(emitted).toEqual([300]);
  });

  it('clamps the width to the valid pixel range while dragging', () => {
    const fixture = createFixture();
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    dispatchPointer(divider, 'pointerdown', 224);
    dispatchPointer(window, 'pointermove', -500);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('200px');

    dispatchPointer(window, 'pointermove', 5000);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('480px');

    dispatchPointer(window, 'pointerup', 5000);
  });

  it('arrow keys resize a focused divider by 8px and emit the new width immediately', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.widthPxChanged.subscribe((width) => emitted.push(width));
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([232]);
    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('232px');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
    fixture.detectChanges();

    expect(emitted).toEqual([232, 224]);
  });

  it('Home and End jump to the minimum and maximum widths', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.widthPxChanged.subscribe((width) => emitted.push(width));
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('480px');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('200px');

    expect(emitted).toEqual([480, 200]);
  });

  it('ignores non-arrow keys on the divider', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.widthPxChanged.subscribe((width) => emitted.push(width));
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');

    divider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

    expect(emitted).toEqual([]);
  });

  it('exposes the divider as a WAI-ARIA vertical separator with the current width', () => {
    const fixture = createFixture();

    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');
    expect(divider.getAttribute('role')).toBe('separator');
    expect(divider.getAttribute('aria-orientation')).toBe('vertical');
    expect(divider.getAttribute('aria-valuenow')).toBe('224');
    expect(divider.getAttribute('aria-valuemin')).toBe('200');
    expect(divider.getAttribute('aria-valuemax')).toBe('480');
    expect(divider.getAttribute('tabindex')).toBe('0');
  });

  it('collapsing hides the sidebar and leaves a reopen affordance in its place', () => {
    const fixture = createFixture();

    expect(fixture.nativeElement.querySelector('.sidebar-pane')).toBeTruthy();

    const toggle: HTMLButtonElement = fixture.nativeElement.querySelector('.collapse-toggle');
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.getAttribute('aria-controls')).toBe('meetings-sidebar');
    toggle.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.sidebar-pane')).toBeNull();
    const collapsedToggle: HTMLButtonElement = fixture.nativeElement.querySelector('.collapse-toggle');
    expect(collapsedToggle.getAttribute('aria-expanded')).toBe('false');
    expect(collapsedToggle.getAttribute('aria-controls')).toBe('meetings-sidebar');
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

  it('reopening restores the PREVIOUS width, not a default, after a drag then a collapse/expand cycle', () => {
    const fixture = createFixture();
    const divider: HTMLElement = fixture.nativeElement.querySelector('.divider-zone');
    dispatchPointer(divider, 'pointerdown', 224);
    dispatchPointer(window, 'pointermove', 320);
    dispatchPointer(window, 'pointerup', 320);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('320px');

    fixture.nativeElement.querySelector('.collapse-toggle').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.sidebar-pane')).toBeNull();

    fixture.nativeElement.querySelector('.collapse-toggle').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('320px');
  });

  it('does not start a drag when the pointerdown originates on the collapse toggle', () => {
    const fixture = createFixture();
    const emitted: number[] = [];
    fixture.componentInstance.widthPxChanged.subscribe((width) => emitted.push(width));
    const toggle: HTMLElement = fixture.nativeElement.querySelector('.collapse-toggle');

    dispatchPointer(toggle, 'pointerdown', 350);
    dispatchPointer(window, 'pointermove', 350);
    dispatchPointer(window, 'pointerup', 350);
    fixture.detectChanges();

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.sidebar-pane').style.width).toBe('224px');
  });
});
