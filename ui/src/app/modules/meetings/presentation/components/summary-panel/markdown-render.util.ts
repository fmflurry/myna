import { marked } from 'marked';

/**
 * Renders markdown to sanitized HTML for read-only display.
 *
 * Pure function: HTML string out (never `SafeHtml` — the template relies on
 * Angular's `[innerHTML]` sanitizer). Raw HTML is disabled by stripping
 * script elements, and `javascript:` link targets are neutralized. Never
 * throws: partial input like `**open` falls back to escaped text.
 */
export function renderMarkdown(markdown: string): string {
  if (markdown.trim() === '') {
    return '';
  }
  try {
    const raw = marked.parse(markdown, { gfm: true, breaks: true, async: false }) as string;
    return sanitizeHtml(typeof raw === 'string' ? raw : String(raw));
  } catch {
    return escapeHtml(markdown);
  }
}

function sanitizeHtml(html: string): string {
  const withoutScripts = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script\s*>/gi, '')
    .replace(/<\/?script\b[^>]*>/gi, '');
  return withoutScripts
    .replace(/\shref=(["'])\s*javascript:[^"']*\1/gi, ' href="#"')
    .replace(/\shref=(["'])\s*vbscript:[^"']*\1/gi, ' href="#"')
    .replace(/\shref=(["'])\s*data:text\/html[^"']*\1/gi, ' href="#"');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
