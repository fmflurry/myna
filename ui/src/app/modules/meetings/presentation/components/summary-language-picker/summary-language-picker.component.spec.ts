import { TestBed } from '@angular/core/testing';

import type { SummaryLanguage } from '../../../core/models/summary-language.model';
import { SummaryLanguagePickerComponent } from './summary-language-picker.component';

describe('SummaryLanguagePickerComponent', () => {
  const languages: SummaryLanguage[] = [
    { code: 'en', label: 'English' },
    { code: 'fr', label: 'French' },
  ];

  const createFixture = () => {
    const fixture = TestBed.createComponent(SummaryLanguagePickerComponent);
    fixture.componentRef.setInput('languages', languages);
    fixture.componentRef.setInput('selectedLanguage', 'en');
    fixture.detectChanges();
    return fixture;
  };

  it('renders one option per language supplied via the input, not a hardcoded list', () => {
    const fixture = createFixture();

    const options: HTMLOptionElement[] = Array.from(fixture.nativeElement.querySelectorAll('option'));
    expect(options.length).toBe(2);
    expect(options.map((option) => option.value)).toEqual(['en', 'fr']);
    expect(options.map((option) => option.textContent?.trim())).toEqual(['English', 'French']);
  });

  it('reflects the selectedLanguage input as the chosen option', () => {
    const fixture = TestBed.createComponent(SummaryLanguagePickerComponent);
    fixture.componentRef.setInput('languages', languages);
    fixture.componentRef.setInput('selectedLanguage', 'fr');
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    expect(select.value).toBe('fr');
  });

  it('emits languageSelected with the chosen code on change', () => {
    const fixture = createFixture();
    const emitted: string[] = [];
    fixture.componentInstance.languageSelected.subscribe((code) => emitted.push(code));

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    select.value = 'fr';
    select.dispatchEvent(new Event('change'));

    expect(emitted).toEqual(['fr']);
  });

  it('disables the select when there are no languages yet', () => {
    const fixture = TestBed.createComponent(SummaryLanguagePickerComponent);
    fixture.componentRef.setInput('selectedLanguage', 'en');
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    expect(select.disabled).toBe(true);
  });

  it('disables the select when the disabled input is set', () => {
    const fixture = TestBed.createComponent(SummaryLanguagePickerComponent);
    fixture.componentRef.setInput('languages', languages);
    fixture.componentRef.setInput('selectedLanguage', 'en');
    fixture.componentRef.setInput('disabled', true);
    fixture.detectChanges();

    const select: HTMLSelectElement = fixture.nativeElement.querySelector('select');
    expect(select.disabled).toBe(true);
  });
});
