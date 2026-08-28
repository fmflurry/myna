import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

interface LicenceEntry {
  readonly name: string;
  readonly licence: string;
  readonly note: string;
}

/** Fixed licence obligations for the third-party models and runtimes Myna embeds. */
const LICENCE_ENTRIES: readonly LicenceEntry[] = [
  {
    name: 'Parakeet-TDT weights',
    licence: 'CC-BY-4.0',
    note: 'Attribution required — see NVIDIA NeMo Parakeet-TDT model card.',
  },
  {
    name: 'sherpa-onnx',
    licence: 'Apache-2.0',
    note: 'Speech-to-text runtime.',
  },
  {
    name: 'llama.cpp',
    licence: 'MIT',
    note: 'Embedded in-process LLM runtime for Qwen summarization.',
  },
  {
    name: 'Poppins & Inter',
    licence: 'SIL Open Font License 1.1',
    note: 'Brand and product UI typefaces, self-hosted — no external font requests.',
  },
  {
    name: 'Myna',
    licence: 'MIT',
    note: 'This application.',
  },
];

/** Licence-obligation surface — not decoration. Reachable from an About entry point. */
@Component({
  selector: 'app-attribution',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './attribution.component.html',
  styleUrl: './attribution.component.scss',
})
export class AttributionComponent {
  /** Sourced from `app_version()` via `MeetingsFacade.appVersion` — never hardcoded here. */
  readonly version = input<string | undefined>(undefined);

  readonly closed = output<void>();

  readonly entries = LICENCE_ENTRIES;
}
