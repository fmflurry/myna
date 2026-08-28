import { TestBed, type ComponentFixture } from '@angular/core/testing';

import { SearchableSelectComponent, type SearchableSelectOption } from './searchable-select.component';

const OPTIONS: readonly SearchableSelectOption[] = [
  { id: 'system:all', name: 'All system audio' },
  { id: 'app:teams', name: 'Teams' },
  { id: 'app:slack', name: 'Slack' },
  { id: 'app:zoom', name: 'Zoom' },
];

describe('SearchableSelectComponent', () => {
  const createFixture = (): ComponentFixture<SearchableSelectComponent> => {
    const fixture = TestBed.createComponent(SearchableSelectComponent);
    fixture.componentRef.setInput('options', OPTIONS);
    fixture.componentRef.setInput('selectedId', 'system:all');
    fixture.detectChanges();
    return fixture;
  };

  const getInput = (fixture: ComponentFixture<SearchableSelectComponent>): HTMLInputElement =>
    fixture.nativeElement.querySelector('.ss-input');

  const getOptions = (fixture: ComponentFixture<SearchableSelectComponent>): HTMLLIElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.ss-option'));

  const getOption = (
    fixture: ComponentFixture<SearchableSelectComponent>,
    index: number,
  ): HTMLLIElement => {
    const option = getOptions(fixture)[index];
    if (!option) {
      throw new Error(`Expected an .ss-option at index ${index}`);
    }
    return option;
  };

  const open = (fixture: ComponentFixture<SearchableSelectComponent>): void => {
    getInput(fixture).dispatchEvent(new Event('focus'));
    fixture.detectChanges();
  };

  const typeFilter = (fixture: ComponentFixture<SearchableSelectComponent>, value: string): void => {
    const field = getInput(fixture);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };

  const pressKey = (fixture: ComponentFixture<SearchableSelectComponent>, key: string): void => {
    getInput(fixture).dispatchEvent(new KeyboardEvent('keydown', { key }));
    fixture.detectChanges();
  };

  it('shows the selected option name in the closed state', () => {
    const fixture = createFixture();

    expect(getInput(fixture).value).toBe('All system audio');
    expect(fixture.nativeElement.querySelector('.ss-listbox')).toBeNull();
  });

  it('opens the listbox on focus, listing every option and highlighting the current selection', () => {
    const fixture = createFixture();

    open(fixture);

    expect(getOptions(fixture).map((el) => el.textContent?.trim())).toEqual([
      'All system audio',
      'Teams',
      'Slack',
      'Zoom',
    ]);
    expect(getOption(fixture, 0).classList.contains('selected')).toBe(true);
  });

  it('narrows the list as the user types, case-insensitively', () => {
    const fixture = createFixture();
    open(fixture);

    typeFilter(fixture, 'ea');

    expect(getOptions(fixture).map((el) => el.textContent?.trim())).toEqual(['Teams']);
  });

  it('shows a "No matching applications" state when nothing matches the filter', () => {
    const fixture = createFixture();
    open(fixture);

    typeFilter(fixture, 'zzz');

    expect(getOptions(fixture).length).toBe(0);
    const empty = fixture.nativeElement.querySelector('.ss-empty');
    expect(empty?.textContent).toContain('No matching applications');
  });

  it('resets the active option to the first match whenever the filter changes', () => {
    const fixture = createFixture();
    open(fixture);
    pressKey(fixture, 'ArrowDown');
    pressKey(fixture, 'ArrowDown');

    typeFilter(fixture, 'sla');

    expect(getOptions(fixture).map((el) => el.textContent?.trim())).toEqual(['Slack']);
    expect(getOption(fixture, 0).classList.contains('active')).toBe(true);
  });

  it('moves the active option down and up with the arrow keys', () => {
    const fixture = createFixture();
    open(fixture);

    pressKey(fixture, 'ArrowDown');
    expect(getOption(fixture, 1).classList.contains('active')).toBe(true);

    pressKey(fixture, 'ArrowUp');
    expect(getOption(fixture, 0).classList.contains('active')).toBe(true);
  });

  it('clamps at the last option instead of wrapping past the end', () => {
    const fixture = createFixture();
    open(fixture);

    for (let i = 0; i < 10; i += 1) {
      pressKey(fixture, 'ArrowDown');
    }

    expect(getOption(fixture, 3).classList.contains('active')).toBe(true);
  });

  it('clamps at the first option instead of wrapping past the start', () => {
    const fixture = createFixture();
    open(fixture);

    pressKey(fixture, 'ArrowUp');
    pressKey(fixture, 'ArrowUp');

    expect(getOption(fixture, 0).classList.contains('active')).toBe(true);
  });

  it('jumps to the first and last of the filtered list with Home and End', () => {
    const fixture = createFixture();
    open(fixture);

    pressKey(fixture, 'End');
    expect(getOption(fixture, 3).classList.contains('active')).toBe(true);

    pressKey(fixture, 'Home');
    expect(getOption(fixture, 0).classList.contains('active')).toBe(true);
  });

  it('selects the active option and emits its id on Enter', () => {
    const fixture = createFixture();
    open(fixture);
    const emitted: string[] = [];
    fixture.componentInstance.selectionChange.subscribe((id) => emitted.push(id));

    pressKey(fixture, 'ArrowDown');
    pressKey(fixture, 'Enter');

    expect(emitted).toEqual(['app:teams']);
    expect(fixture.nativeElement.querySelector('.ss-listbox')).toBeNull();
  });

  it('closes on Escape without emitting a selection change', () => {
    const fixture = createFixture();
    open(fixture);
    const emitted: string[] = [];
    fixture.componentInstance.selectionChange.subscribe((id) => emitted.push(id));

    pressKey(fixture, 'ArrowDown');
    pressKey(fixture, 'Escape');

    expect(emitted).toEqual([]);
    expect(fixture.nativeElement.querySelector('.ss-listbox')).toBeNull();
    expect(getInput(fixture).value).toBe('All system audio');
  });

  it('emits the clicked option id and closes the list', () => {
    const fixture = createFixture();
    open(fixture);
    const emitted: string[] = [];
    fixture.componentInstance.selectionChange.subscribe((id) => emitted.push(id));

    getOption(fixture, 2).dispatchEvent(new Event('mousedown'));
    fixture.detectChanges();

    expect(emitted).toEqual(['app:slack']);
    expect(fixture.nativeElement.querySelector('.ss-listbox')).toBeNull();
  });

  it('caps the popup at a fixed max height and scrolls beyond it', () => {
    const fixture = createFixture();
    open(fixture);

    const listbox: HTMLElement = fixture.nativeElement.querySelector('.ss-listbox');
    expect(listbox.style.overflowY).toBe('auto');
    expect(listbox.style.maxHeight).toContain('--select-popup-max-height');
  });

  it('exposes combobox ARIA semantics that track the active option', () => {
    const fixture = createFixture();
    const field = getInput(fixture);

    expect(field.getAttribute('role')).toBe('combobox');
    expect(field.getAttribute('aria-expanded')).toBe('false');

    open(fixture);

    const listbox: HTMLElement = fixture.nativeElement.querySelector('.ss-listbox');
    expect(field.getAttribute('aria-expanded')).toBe('true');
    expect(field.getAttribute('aria-controls')).toBe(listbox.id);
    expect(listbox.getAttribute('role')).toBe('listbox');
    expect(field.getAttribute('aria-activedescendant')).toBe(getOption(fixture, 0).id);
  });

  it('does not open the listbox when disabled', () => {
    const fixture = createFixture();
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    open(fixture);

    expect(fixture.nativeElement.querySelector('.ss-listbox')).toBeNull();
  });
});
