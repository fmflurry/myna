import { renderMarkdown } from './markdown-render.util';

/**
 * RED-phase contract for the markdown renderer util.
 *
 * The util does not exist yet — these specs MUST fail (module resolution /
 * assertion failure) until the `marked`-backed `renderMarkdown` implementation
 * lands. View behaviour: formatted HTML out, raw markers gone, XSS
 * neutralised. Edit behaviour stays raw (covered in
 * `summary-panel.component.spec.ts`).
 */
describe('renderMarkdown', () => {
  it('renders an ATX heading as h1 without the raw marker', () => {
    expect(renderMarkdown('# Hello')).toContain('<h1');
    expect(renderMarkdown('# Hello')).toContain('Hello');
    expect(renderMarkdown('# Hello')).not.toContain('# Hello');
  });

  it('renders an unordered list as list items', () => {
    const html = renderMarkdown('- alpha\n- beta');
    expect(html).toContain('<ul');
    expect(html).toContain('<li');
    expect(html).toContain('alpha');
    expect(html).toContain('beta');
  });

  it('renders bold markers as strong', () => {
    const html = renderMarkdown('a **bold** word');
    expect(html).toContain('<strong>');
    expect(html).toContain('bold');
    expect(html).not.toContain('**bold**');
  });

  it('renders inline code and fenced code blocks', () => {
    expect(renderMarkdown('use `myna` here')).toContain('<code>');
    const fenced = renderMarkdown('```\nconst a = 1;\n```');
    expect(fenced).toContain('<code');
    expect(fenced).toContain('const a = 1;');
  });

  it('renders blockquotes', () => {
    const html = renderMarkdown('> quoted line');
    expect(html).toContain('<blockquote');
    expect(html).toContain('quoted line');
  });

  it('renders tables', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table');
    expect(html).toContain('<td');
  });

  it('returns an empty string for empty or blank markdown', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });

  it('escapes or strips script tags — no executable script element', () => {
    const html = renderMarkdown('# Title\n<script>alert(1)</script>');
    const host = document.createElement('div');
    host.innerHTML = html;
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('h1')).toBeTruthy();
    expect(html).not.toContain('<script>');
  });

  it('neutralizes javascript: link targets', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    const host = document.createElement('div');
    host.innerHTML = html;
    const anchor = host.querySelector('a');
    expect(anchor).toBeTruthy();
    expect(anchor?.getAttribute('href')?.toLowerCase().startsWith('javascript:')).toBe(false);
  });

  it('does not throw on unclosed emphasis and returns a string', () => {
    let html = '';
    expect(() => {
      html = renderMarkdown('unclosed **partial');
    }).not.toThrow();
    expect(typeof html).toBe('string');
    expect(html).toContain('partial');
  });
});
