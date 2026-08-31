import { resolveDropEdge } from './reorder-geometry.util';

/**
 * Pure geometry — no DOM, no Angular. Takes a plain `{ top, height }` rather
 * than a real `DOMRect` because jsdom's `getBoundingClientRect` always
 * returns an all-zero rect, which is exactly the degenerate case case (4)
 * below pins.
 */
describe('resolveDropEdge', () => {
  it('resolves to "before" when clientY sits in the top half of the row', () => {
    expect(resolveDropEdge({ top: 100, height: 40 }, 110)).toBe('before');
  });

  it('resolves to "after" when clientY sits in the bottom half of the row', () => {
    expect(resolveDropEdge({ top: 100, height: 40 }, 130)).toBe('after');
  });

  it('resolves to "after" at the exact midpoint — the boundary belongs to "after", not "before"', () => {
    expect(resolveDropEdge({ top: 100, height: 40 }, 120)).toBe('after');
  });

  it('resolves to "before" for an all-zero rect (jsdom\'s getBoundingClientRect)', () => {
    expect(resolveDropEdge({ top: 0, height: 0 }, 0)).toBe('before');
  });

  it('resolves to "before" for a non-finite clientY', () => {
    expect(resolveDropEdge({ top: 100, height: 40 }, Number.NaN)).toBe('before');
  });
});
