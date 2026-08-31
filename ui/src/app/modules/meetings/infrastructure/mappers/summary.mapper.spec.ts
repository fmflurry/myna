import { mapSummaryDtoToDomain, mapSummaryLanguageDtoToDomain, mapSummaryRefDtoToDomain } from './summary.mapper';

describe('mapSummaryDtoToDomain', () => {
  it('maps every field, parsing createdAt into a Date', () => {
    const summary = mapSummaryDtoToDomain({
      template: 'key-points',
      markdown: '# Key Points',
      createdAt: '2026-01-15T10:00:00Z',
      language: 'fr',
    });

    expect(summary.template).toBe('key-points');
    expect(summary.markdown).toBe('# Key Points');
    expect(summary.createdAt).toEqual(new Date('2026-01-15T10:00:00Z'));
    expect(summary.language).toBe('fr');
  });

  it('is never stale — a freshly generated summary always maps to stale: false', () => {
    const summary = mapSummaryDtoToDomain({
      template: 'key-points',
      markdown: '# Key Points',
      createdAt: '2026-01-15T10:00:00Z',
      language: 'fr',
    });

    expect(summary.stale).toBe(false);
  });
});

describe('mapSummaryRefDtoToDomain', () => {
  it('maps template, createdAt and language, defaulting markdown to an empty string', () => {
    const summary = mapSummaryRefDtoToDomain({
      template: 'action-items',
      createdAt: '2026-01-15T10:05:00Z',
      path: '/data/meetings/m-1/action-items.md',
      language: 'en',
      stale: false,
    });

    expect(summary).toEqual({
      template: 'action-items',
      markdown: '',
      createdAt: new Date('2026-01-15T10:05:00Z'),
      language: 'en',
      stale: false,
    });
  });

  it('passes stale: true through unchanged', () => {
    const summary = mapSummaryRefDtoToDomain({
      template: 'action-items',
      createdAt: '2026-01-15T10:05:00Z',
      path: '/data/meetings/m-1/action-items.md',
      language: 'en',
      stale: true,
    });

    expect(summary.stale).toBe(true);
  });
});

describe('mapSummaryLanguageDtoToDomain', () => {
  it('maps code and label through unchanged', () => {
    const language = mapSummaryLanguageDtoToDomain({ code: 'fr', label: 'French' });

    expect(language).toEqual({ code: 'fr', label: 'French' });
  });
});
