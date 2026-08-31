import { applyReplace, countMatches } from './summary-panel.component.support';

describe('applyReplace', () => {
  it('replaces only the first occurrence in first mode', () => {
    expect(applyReplace('Jon met Jon', 'Jon', 'Joan', 'first')).toBe('Joan met Jon');
  });

  it('replaces every occurrence in all mode', () => {
    expect(applyReplace('Jon met Jon and Jon', 'Jon', 'Joan', 'all')).toBe(
      'Joan met Joan and Joan',
    );
  });

  it('returns the input unchanged when there is no match', () => {
    expect(applyReplace('# Key points', 'missing', 'x', 'first')).toBe('# Key points');
    expect(applyReplace('# Key points', 'missing', 'x', 'all')).toBe('# Key points');
  });

  it('returns the input unchanged when find is empty', () => {
    expect(applyReplace('# Key points', '', 'x', 'first')).toBe('# Key points');
    expect(applyReplace('# Key points', '', 'x', 'all')).toBe('# Key points');
  });

  it('leaves later occurrences intact when replacing first with multiple occurrences', () => {
    expect(applyReplace('aa bb aa bb aa', 'aa', 'XX', 'first')).toBe('XX bb aa bb aa');
  });

  it('is case-sensitive', () => {
    expect(applyReplace('Myna myna MYNA', 'myna', 'bird', 'all')).toBe('Myna bird MYNA');
  });

  it('treats find text literally — no regex metacharacter interpretation', () => {
    expect(applyReplace('a.c abc', 'a.c', 'X', 'all')).toBe('X abc');
  });
});

describe('countMatches', () => {
  it('counts non-overlapping occurrences', () => {
    expect(countMatches('Jon met Jon and Jon', 'Jon')).toBe(3);
  });

  it('returns 0 for an empty find', () => {
    expect(countMatches('# Points', '')).toBe(0);
  });

  it('returns 0 when there is no match', () => {
    expect(countMatches('# Points', 'missing')).toBe(0);
  });
});
