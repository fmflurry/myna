// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { clearHighlights, findMatchRanges, highlightMatches } from './summary-search.util';

describe('findMatchRanges', () => {
  it('returns an empty array for an empty needle', () => {
    expect(findMatchRanges('some summary', '')).toEqual([]);
    expect(findMatchRanges('', '')).toEqual([]);
  });

  it('returns an empty array when there is no match', () => {
    expect(findMatchRanges('# Key points', 'missing')).toEqual([]);
    expect(findMatchRanges('', 'myna')).toEqual([]);
  });

  it('reports half-open start/end ranges', () => {
    expect(findMatchRanges('Jon met Jon', 'Jon')).toEqual([
      { start: 0, end: 3 },
      { start: 8, end: 11 },
    ]);
  });

  it('treats the needle literally — no regex interpretation', () => {
    expect(findMatchRanges('a.c abc', 'a.c')).toHaveLength(1);
    expect(findMatchRanges('abc axc', 'a.c')).toEqual([]);
    expect(findMatchRanges('(a+b)* matches', '(a+b)*')).toHaveLength(1);
    expect(findMatchRanges('aab matches', '(a+b)*')).toEqual([]);
    expect(findMatchRanges('price $5 [sale] \\d', '$5 [sale] \\d')).toHaveLength(1);
  });

  it('matches case-insensitively', () => {
    const matches = findMatchRanges('Myna myna MYNA', 'myna');
    expect(matches).toHaveLength(3);
    expect(matches.map((match) => match.start)).toEqual([0, 5, 10]);
    expect(findMatchRanges('Meeting Notes', 'MEETING')).toHaveLength(1);
  });

  it('finds non-overlapping matches only', () => {
    expect(findMatchRanges('aaa', 'aa')).toHaveLength(1);
    const matches = findMatchRanges('abababa', 'aba');
    expect(matches.map((match) => match.start)).toEqual([0, 4]);
  });

  it('handles unicode without splitting surrogate pairs', () => {
    expect(findMatchRanges('CAFÉ au lait', 'café')).toHaveLength(1);
    const text = '🎉 party 🎉';
    const emoji = findMatchRanges(text, '🎉');
    expect(emoji).toHaveLength(2);
    expect(emoji[0]).toEqual({ start: 0, end: 2 });
    emoji.forEach((match) => {
      expect(text.slice(match.start, match.end)).toBe('🎉');
    });
    expect(findMatchRanges('naïve NAÏVE', 'naïve')).toHaveLength(2);
  });
});

describe('highlightMatches', () => {
  it('returns 0 and adds no marks for an empty query', () => {
    const host = document.createElement('div');
    host.textContent = 'some summary';
    expect(highlightMatches(host, '')).toBe(0);
    expect(host.querySelectorAll('mark')).toHaveLength(0);
    expect(host.textContent).toBe('some summary');
  });

  it('wraps case-insensitive matches in marks and preserves text', () => {
    const host = document.createElement('div');
    host.textContent = 'Myna myna MYNA';
    expect(highlightMatches(host, 'myna')).toBe(3);
    expect(host.querySelectorAll('mark[data-search-mark]')).toHaveLength(3);
    expect(host.textContent).toBe('Myna myna MYNA');
  });

  it('treats the query literally in the DOM', () => {
    const host = document.createElement('div');
    host.textContent = 'a.c abc';
    expect(highlightMatches(host, 'a.c')).toBe(1);
    expect(host.querySelectorAll('mark[data-search-mark]')).toHaveLength(1);
  });

  it('highlights unicode matches without corrupting surrogate pairs', () => {
    const host = document.createElement('div');
    host.textContent = '🎉 party 🎉';
    expect(highlightMatches(host, '🎉')).toBe(2);
    expect(host.querySelectorAll('mark[data-search-mark]')).toHaveLength(2);
    expect(host.textContent).toBe('🎉 party 🎉');
  });

  it('marks only the active match with aria-current', () => {
    const host = document.createElement('div');
    host.textContent = 'one two one';
    highlightMatches(host, 'one', 1);
    const marks = host.querySelectorAll('mark[data-search-mark]');
    expect(marks).toHaveLength(2);
    expect(marks[0]?.getAttribute('aria-current')).toBeNull();
    expect(marks[1]?.getAttribute('aria-current')).toBe('true');
  });

  it('sets no aria-current when the active index is out of range', () => {
    const host = document.createElement('div');
    host.textContent = 'one two one';
    highlightMatches(host, 'one', 7);
    const marks = host.querySelectorAll('mark[data-search-mark]');
    expect(marks).toHaveLength(2);
    marks.forEach((mark) => {
      expect(mark.getAttribute('aria-current')).toBeNull();
    });
  });

  it('replaces previous highlights on a new query', () => {
    const host = document.createElement('div');
    host.textContent = 'alpha beta alpha';
    highlightMatches(host, 'alpha');
    expect(host.querySelectorAll('mark[data-search-mark]')).toHaveLength(2);
    highlightMatches(host, 'beta');
    const marks = host.querySelectorAll('mark[data-search-mark]');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('beta');
    expect(host.textContent).toBe('alpha beta alpha');
  });
});

describe('clearHighlights', () => {
  it('removes marks while preserving text', () => {
    const host = document.createElement('div');
    host.textContent = 'hello hello';
    highlightMatches(host, 'hello');
    expect(host.querySelectorAll('mark')).toHaveLength(2);
    clearHighlights(host);
    expect(host.querySelectorAll('mark')).toHaveLength(0);
    expect(host.textContent).toBe('hello hello');
  });

  it('leaves non-search marks untouched', () => {
    const host = document.createElement('div');
    host.innerHTML = 'a <mark>manual</mark> b';
    clearHighlights(host);
    expect(host.querySelectorAll('mark')).toHaveLength(1);
  });
});
