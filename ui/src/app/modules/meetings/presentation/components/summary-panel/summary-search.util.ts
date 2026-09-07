/**
 * Case-insensitive literal search over rendered summary text, plus DOM
 * highlight helpers for the read-only summary viewer.
 *
 * Unlike `summary-panel.component.support.ts` (case-sensitive raw-markdown
 * edit helpers), this util targets the rendered `textContent` shown via
 * `renderMarkdown(marked)` + `[innerHTML]`. The needle is always treated as
 * a plain string — never a regex — so metacharacters need no escaping.
 *
 * Unicode note: case folding uses `toLowerCase()` on both sides and offsets
 * are UTF-16 code units (matching DOM `Text.data` indexing), so surrogate
 * pairs such as emoji are never split. Rare foldings that change string
 * length (e.g. Turkish dotted capital I) may shift offsets; accented Latin,
 * CJK and emoji — the summary vocabulary — fold length-preserving.
 */

/** A half-open `[start, end)` range into a string (UTF-16 code units). */
export interface SearchMatch {
  readonly start: number;
  readonly end: number;
}

const MARK_SELECTOR = 'mark[data-search-mark]';

/**
 * Non-overlapping case-insensitive literal occurrences of `needle` in
 * `haystack`. Returns `[]` when `needle` is empty (an empty query matches
 * nothing, so the announced count stays honest) or when there is no match.
 */
export const findMatchRanges = (haystack: string, needle: string): readonly SearchMatch[] => {
  if (needle === '') {
    return [];
  }
  const loweredHaystack = haystack.toLowerCase();
  const loweredNeedle = needle.toLowerCase();
  const step = needle.length;
  const matches: SearchMatch[] = [];
  let from = 0;
  while (from <= loweredHaystack.length) {
    const index = loweredHaystack.indexOf(loweredNeedle, from);
    if (index === -1) {
      return matches;
    }
    matches.push({ start: index, end: index + step });
    from = index + step;
  }
  return matches;
};

const collectTextNodes = (root: HTMLElement): Text[] => {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let current = walker.nextNode();
  while (current !== null) {
    if (current.nodeType === Node.TEXT_NODE) {
      const text = current as Text;
      const parent = text.parentNode;
      const parentName = parent instanceof Element ? parent.tagName : '';
      if (parentName !== 'SCRIPT' && parentName !== 'STYLE' && text.data !== '') {
        nodes.push(text);
      }
    }
    current = walker.nextNode();
  }
  return nodes;
};

/**
 * Removes search highlights added by `highlightMatches`, restoring the
 * original text nodes. Keeps non-search `<mark>` elements untouched.
 */
export const clearHighlights = (root: HTMLElement): void => {
  const marks = root.querySelectorAll(MARK_SELECTOR);
  marks.forEach((mark) => {
    const parent = mark.parentNode;
    if (parent === null) {
      return;
    }
    while (mark.firstChild !== null) {
      parent.insertBefore(mark.firstChild, mark);
    }
    parent.removeChild(mark);
  });
  root.normalize();
};

/**
 * Wraps every case-insensitive literal occurrence of `needle` in the text
 * nodes under `root` in `<mark data-search-mark>`, returning the total
 * match count. Previous search highlights are cleared first; an empty
 * `needle` clears and returns 0. The match at `activeIndex` (document order,
 * zero-based) additionally gets `aria-current="true"`; an absent or
 * out-of-range index leaves every mark without it.
 */
export const highlightMatches = (
  root: HTMLElement,
  needle: string,
  activeIndex?: number | undefined,
): number => {
  clearHighlights(root);
  if (needle === '') {
    return 0;
  }
  const doc = root.ownerDocument;
  const textNodes = collectTextNodes(root);
  const perNode: SearchMatch[][] = textNodes.map((node) => [
    ...findMatchRanges(node.data, needle),
  ]);
  let total = 0;
  perNode.forEach((ranges, nodeIndex) => {
    const node = textNodes[nodeIndex];
    if (node === undefined || ranges.length === 0) {
      return;
    }
    const base = total;
    total += ranges.length;
    for (let i = ranges.length - 1; i >= 0; i--) {
      const range = ranges[i];
      if (range === undefined) {
        continue;
      }
      node.splitText(range.end);
      const matchNode = node.splitText(range.start);
      const parent = matchNode.parentNode;
      if (parent === null) {
        continue;
      }
      const mark = doc.createElement('mark');
      mark.setAttribute('data-search-mark', 'true');
      if (activeIndex !== undefined && base + i === activeIndex) {
        mark.setAttribute('aria-current', 'true');
      }
      parent.insertBefore(mark, matchNode);
      mark.appendChild(matchNode);
    }
  });
  return total;
};
