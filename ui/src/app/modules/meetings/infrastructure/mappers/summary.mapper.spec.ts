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
});

describe('mapSummaryRefDtoToDomain', () => {
  it('maps template, createdAt and language, defaulting markdown to an empty string', () => {
    const summary = mapSummaryRefDtoToDomain({
      template: 'action-items',
      createdAt: '2026-01-15T10:05:00Z',
      path: '/data/meetings/m-1/action-items.md',
      language: 'en',
    });

    expect(summary).toEqual({
      template: 'action-items',
      markdown: '',
      createdAt: new Date('2026-01-15T10:05:00Z'),
      language: 'en',
    });
  });
});

describe('mapSummaryLanguageDtoToDomain', () => {
  it('maps code and label through unchanged', () => {
    const language = mapSummaryLanguageDtoToDomain({ code: 'fr', label: 'French' });

    expect(language).toEqual({ code: 'fr', label: 'French' });
  });
});
