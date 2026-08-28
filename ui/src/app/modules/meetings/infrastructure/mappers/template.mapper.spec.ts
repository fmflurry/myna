import { formatTemplateLabel } from '../../presentation/utils/format-display.util';
import { mapTemplateDtoToDomain } from './template.mapper';

describe('mapTemplateDtoToDomain', () => {
  it('maps name, description, and prompt verbatim', () => {
    const template = mapTemplateDtoToDomain({
      name: 'key-points',
      description: 'Extract the key points discussed in the meeting.',
      prompt: 'Summarize: {transcript}',
      section_schema: { type: 'object', properties: { key_points: { type: 'array' } } },
      label: null,
      emoji: null,
    });

    expect(template).toEqual({
      name: 'key-points',
      description: 'Extract the key points discussed in the meeting.',
      prompt: 'Summarize: {transcript}',
    });
  });

  it('omits sectionSchema even when section_schema is null', () => {
    const template = mapTemplateDtoToDomain({
      name: 'decisions',
      description: 'List decisions made.',
      prompt: 'Decisions: {transcript}',
      section_schema: null,
      label: null,
      emoji: null,
    });

    expect(template.sectionSchema).toBeUndefined();
  });

  it('carries label and emoji through when both are present on the wire', () => {
    const template = mapTemplateDtoToDomain({
      name: 'meeting-notes',
      description: 'Summarize the meeting.',
      prompt: 'Notes: {transcript}',
      section_schema: null,
      label: 'Notes',
      emoji: '📝',
    });

    expect(template.label).toBe('Notes');
    expect(template.emoji).toBe('📝');
  });

  it('leaves label and emoji absent (not null, not empty string) when neither is present on the wire', () => {
    const template = mapTemplateDtoToDomain({
      name: 'custom-template',
      description: 'A user-authored template predating label/emoji.',
      prompt: 'Custom: {transcript}',
      section_schema: null,
      label: null,
      emoji: null,
    });

    expect(template.label).toBeUndefined();
    expect(template.emoji).toBeUndefined();
    expect('label' in template).toBe(false);
    expect('emoji' in template).toBe(false);
  });

  it('produces the real emoji + label tab caption end to end from DTO to formatTemplateLabel — regression for the generic-icon fallback bug', () => {
    const template = mapTemplateDtoToDomain({
      name: 'meeting-notes',
      description: 'A long, human-written sentence that must never appear in the tab caption.',
      prompt: 'Notes: {transcript}',
      section_schema: null,
      label: 'Notes',
      emoji: '📝',
    });

    expect(formatTemplateLabel(template)).toBe('📝 Notes');
  });
});
