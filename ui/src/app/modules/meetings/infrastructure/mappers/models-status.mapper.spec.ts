import { mapModelSlotDtoToDomain, mapModelsStatusDtoToDomain } from './models-status.mapper';

describe('mapModelSlotDtoToDomain', () => {
  it('maps every field verbatim', () => {
    const slot = mapModelSlotDtoToDomain({
      present: true,
      path: '/models/parakeet-tdt-0.6b-v3-int8',
      expectedFiles: ['encoder.int8.onnx', 'tokens.txt'],
    });

    expect(slot).toEqual({
      present: true,
      path: '/models/parakeet-tdt-0.6b-v3-int8',
      expectedFiles: ['encoder.int8.onnx', 'tokens.txt'],
    });
  });
});

describe('mapModelsStatusDtoToDomain', () => {
  it('maps all three slots plus allPresent', () => {
    const dto = {
      parakeet: { present: true, path: '/models/parakeet', expectedFiles: ['a'] },
      qwen: { present: false, path: '/models/qwen', expectedFiles: ['b'] },
      silero: { present: true, path: '/models/silero', expectedFiles: ['c'] },
      allPresent: false,
    };

    expect(mapModelsStatusDtoToDomain(dto)).toEqual({
      parakeet: { present: true, path: '/models/parakeet', expectedFiles: ['a'] },
      qwen: { present: false, path: '/models/qwen', expectedFiles: ['b'] },
      silero: { present: true, path: '/models/silero', expectedFiles: ['c'] },
      allPresent: false,
    });
  });
});
