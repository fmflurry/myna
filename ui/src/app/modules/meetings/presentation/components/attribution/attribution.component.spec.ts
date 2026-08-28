import { TestBed } from '@angular/core/testing';

import { AttributionComponent } from './attribution.component';

describe('AttributionComponent', () => {
  it('lists the licence obligations for every embedded model and runtime', () => {
    const fixture = TestBed.createComponent(AttributionComponent);
    fixture.detectChanges();

    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Parakeet-TDT weights');
    expect(text).toContain('CC-BY-4.0');
    expect(text).toContain('sherpa-onnx');
    expect(text).toContain('Apache-2.0');
    expect(text).toContain('llama.cpp');
    expect(text).toContain('MIT');
    expect(text).toContain('Myna');
    expect(text).toContain('Poppins & Inter');
    expect(text).toContain('SIL Open Font License 1.1');
  });

  it('shows the app version when provided', () => {
    const fixture = TestBed.createComponent(AttributionComponent);
    fixture.componentRef.setInput('version', '0.3.1');
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.version').textContent).toContain('0.3.1');
  });

  it('omits the version line when no version has been loaded yet', () => {
    const fixture = TestBed.createComponent(AttributionComponent);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.version')).toBeNull();
  });

  it('emits closed when the close button is clicked', () => {
    const fixture = TestBed.createComponent(AttributionComponent);
    fixture.detectChanges();
    const emitted: void[] = [];
    fixture.componentInstance.closed.subscribe(() => emitted.push(undefined));

    fixture.nativeElement.querySelector('.close').click();

    expect(emitted.length).toBe(1);
  });
});
