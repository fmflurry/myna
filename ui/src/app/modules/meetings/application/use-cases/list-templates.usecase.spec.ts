import { TestBed } from '@angular/core/testing';

import { TemplateRepositoryPort } from '../../core/ports/template-repository.port';
import { InMemoryTemplateRepositoryFake } from '../testing/in-memory-template-repository.fake';
import { ListTemplatesUseCase } from './list-templates.usecase';

describe('ListTemplatesUseCase', () => {
  let useCase: ListTemplatesUseCase;
  let repository: InMemoryTemplateRepositoryFake;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ListTemplatesUseCase,
        InMemoryTemplateRepositoryFake,
        { provide: TemplateRepositoryPort, useExisting: InMemoryTemplateRepositoryFake },
      ],
    });
    useCase = TestBed.inject(ListTemplatesUseCase);
    repository = TestBed.inject(InMemoryTemplateRepositoryFake);
  });

  it('returns the built-in templates by default', async () => {
    const templates = await useCase.list();

    expect(templates.length).toBeGreaterThan(0);
  });

  it('returns seeded templates', async () => {
    repository.seed([
      { name: 'action-items', description: 'Action items', prompt: 'List action items.' },
    ]);

    const templates = await useCase.list();

    expect(templates.length).toBe(1);
    expect(templates[0]?.name).toBe('action-items');
  });
});
