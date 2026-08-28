import type { ModelSlot, ModelsStatus } from '../../core/models/models-status.model';
import type { ModelSlotDto, ModelsStatusDto } from '../dto/models-status.dto';

/** Maps a `ModelSlotDto` to the domain `ModelSlot`. */
export function mapModelSlotDtoToDomain(dto: ModelSlotDto): ModelSlot {
  return {
    present: dto.present,
    path: dto.path,
    expectedFiles: dto.expectedFiles,
  };
}

/** Maps a `ModelsStatusDto` to the domain `ModelsStatus`. */
export function mapModelsStatusDtoToDomain(dto: ModelsStatusDto): ModelsStatus {
  return {
    parakeet: mapModelSlotDtoToDomain(dto.parakeet),
    qwen: mapModelSlotDtoToDomain(dto.qwen),
    silero: mapModelSlotDtoToDomain(dto.silero),
    allPresent: dto.allPresent,
  };
}
