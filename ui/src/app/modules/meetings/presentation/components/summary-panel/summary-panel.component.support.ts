/**
 * Pure helpers for the summary panel's edit-mode find/replace toolbar.
 * Kept out of the component so the logic stays trivially testable and the
 * component file stays under the lint line cap.
 */

/** Whether "Replace" should replace only the first occurrence or every occurrence. */
export type ReplaceMode = 'first' | 'all';

/**
 * Number of case-sensitive, non-overlapping occurrences of `find` in
 * `markdown` — 0 when `find` is empty (an empty needle matches nothing, so
 * the announced count stays honest).
 */
export const countMatches = (markdown: string, find: string): number => {
  if (find === '') {
    return 0;
  }
  let count = 0;
  let index = markdown.indexOf(find);
  while (index !== -1) {
    count++;
    index = markdown.indexOf(find, index + find.length);
  }
  return count;
};

/**
 * Case-sensitive plain-string replace on `markdown` — no regex, so `find`
 * and `replacement` are taken literally with no escaping concerns.
 * An empty `find` or a `first`-mode miss returns the input unchanged.
 */
export const applyReplace = (
  markdown: string,
  find: string,
  replacement: string,
  mode: ReplaceMode,
): string => {
  if (find === '') {
    return markdown;
  }
  if (mode === 'all') {
    return markdown.split(find).join(replacement);
  }
  const index = markdown.indexOf(find);
  if (index === -1) {
    return markdown;
  }
  return markdown.slice(0, index) + replacement + markdown.slice(index + find.length);
};
