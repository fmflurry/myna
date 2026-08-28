import { TestBed } from '@angular/core/testing';

import { LevelMeterComponent } from './level-meter.component';

describe('LevelMeterComponent', () => {
  it('renders a zero-width fill when no level is provided', () => {
    const fixture = TestBed.createComponent(LevelMeterComponent);
    fixture.detectChanges();

    const fill: HTMLElement = fixture.nativeElement.querySelector('.fill');
    expect(fill.style.width).toBe('0%');
  });

  it('maps rms to a percentage width, clamped to 100', () => {
    const fixture = TestBed.createComponent(LevelMeterComponent);
    fixture.componentRef.setInput('level', { rms: 1.4, dbfs: 0 });
    fixture.detectChanges();

    const fill: HTMLElement = fixture.nativeElement.querySelector('.fill');
    expect(fill.style.width).toBe('100%');
  });
});
