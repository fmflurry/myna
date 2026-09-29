import { signal } from '@angular/core';

import type { AudioLevel } from '../../core/models/audio-device.model';
import type { TranscriptSegment } from '../../core/models/transcript.model';
import type { LiveHotPathSignals } from './meetings-store-wiring.support';

/**
 * Builds the hot (up to 10 Hz) live-recording state as plain Angular signals,
 * deliberately OFF the flurryx slot schema: flurryx records one deep-cloned
 * FULL STORE snapshot per acknowledged update with no cap (confirmed against
 * `node_modules/@flurryx/store/dist/index.d.ts` — `StoreOptions` has no
 * history-limiting knob; see `meetings.store.live-hot-path.spec.ts`). Plain
 * signals carry no such per-write history cost. Extracted out of
 * `MeetingsStore` to keep that class under the project's `max-lines` budget;
 * this factory is only ever called once, from there.
 */
export function createLiveHotPathSignals(): LiveHotPathSignals {
  return {
    level: signal<AudioLevel | undefined>(undefined),
    partialTextMe: signal(''),
    partialTextOthers: signal(''),
    finalizedSegments: signal<readonly TranscriptSegment[]>([]),
  };
}
