import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import type { MeetingId } from '../../core/models/meeting.model';
import { MeetingsError } from '../../core/models/recording-state.model';
import {
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriAudioRepositoryAdapter } from './tauri-audio-repository.adapter';

/**
 * Specs for the seamless multipart WAV playback contract (RED).
 *
 * Recordings captured by the segmented recorder span `audio.wav`,
 * `audio.part-0002.wav`, ... The backend command `get_meeting_audio_chunks`
 * (registered Rust-side in a later step) returns ordered chunks; the adapter
 * must convert EVERY path through the existing Tauri asset-URL helper
 * (`convertFileSrc`) and hand the player a playable, offset-stamped view.
 *
 * `getAudioChunks` does not exist on the adapter yet — the cast below keeps
 * the spec compiling without touching production code, so each call fails
 * RED with "getAudioChunks is not a function" until multipart playback lands.
 */

/** Wire shape of the Rust `get_meeting_audio_chunks` result (camelCase serde). */
interface AudioChunkDto {
  readonly path: string;
  readonly startSec: number;
  readonly durationSec: number;
}

/** Port view: chunk paths already converted to playable asset URLs. */
interface AudioChunkView {
  readonly url: string;
  readonly startSec: number;
  readonly durationSec: number;
}

/** The contract under test, declared locally so the spec compiles pre-GREEN. */
interface AudioChunksApi {
  getAudioChunks(meetingId: MeetingId): Promise<readonly AudioChunkView[]>;
}

const asChunksApi = (adapter: TauriAudioRepositoryAdapter): AudioChunksApi =>
  adapter as unknown as AudioChunksApi;

/**
 * Installs the shared IPC stub and pins `convertFileSrc` — the asset-URL
 * helper `ipc.ts` delegates to `__TAURI_INTERNALS__.convertFileSrc`, which
 * the base stub does not provide — to a deterministic mapping so assertions
 * can check the exact playable URL.
 */
function installStubWithAssetUrls(handleCommand: (cmd: string, args: unknown) => unknown): void {
  installTauriInternalsStub(handleCommand);
  const internals = (
    globalThis as unknown as { __TAURI_INTERNALS__: Record<string, unknown> }
  ).__TAURI_INTERNALS__;
  internals['convertFileSrc'] = (path: string): string => `asset://localhost/${path}`;
}

describe('TauriAudioRepositoryAdapter', () => {
  let adapter: TauriAudioRepositoryAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriAudioRepositoryAdapter] });
    adapter = TestBed.inject(TauriAudioRepositoryAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('getAudioUrl (legacy) converts the single path through the asset-URL helper', async () => {
    installStubWithAssetUrls((cmd, args) => {
      expect(cmd).toBe('get_meeting_audio_path');
      expect(args).toEqual({ id: 'm-1' });
      return '/myna/meetings/m-1/audio.wav';
    });

    const url = await adapter.getAudioUrl(toMeetingId('m-1'));

    expect(url).toBe('asset://localhost//myna/meetings/m-1/audio.wav');
  });

  it('getAudioUrl (legacy) resolves null when the meeting has no audio', async () => {
    installStubWithAssetUrls(() => null);

    const url = await adapter.getAudioUrl(toMeetingId('m-1'));

    expect(url).toBeNull();
  });

  describe('getAudioChunks', () => {
    it('invokes get_meeting_audio_chunks with the meeting id', async () => {
      let receivedCmd: string | undefined;
      let receivedArgs: unknown;
      installStubWithAssetUrls((cmd, args) => {
        receivedCmd = cmd;
        receivedArgs = args;
        return [];
      });

      await asChunksApi(adapter).getAudioChunks(toMeetingId('m-1'));

      expect(receivedCmd).toBe('get_meeting_audio_chunks');
      expect(receivedArgs).toEqual({ id: 'm-1' });
    });

    it('converts every chunk path and preserves order, startSec and durationSec', async () => {
      const wire: readonly AudioChunkDto[] = [
        { path: '/myna/meetings/m-1/audio.wav', startSec: 0, durationSec: 60 },
        { path: '/myna/meetings/m-1/audio.part-0002.wav', startSec: 60, durationSec: 40 },
      ];
      installStubWithAssetUrls(() => wire);

      const chunks = await asChunksApi(adapter).getAudioChunks(toMeetingId('m-1'));

      expect(chunks).toEqual([
        {
          url: 'asset://localhost//myna/meetings/m-1/audio.wav',
          startSec: 0,
          durationSec: 60,
        },
        {
          url: 'asset://localhost//myna/meetings/m-1/audio.part-0002.wav',
          startSec: 60,
          durationSec: 40,
        },
      ]);
    });

    it('returns a single-chunk array for a legacy non-segmented meeting', async () => {
      const wire: readonly AudioChunkDto[] = [
        { path: '/myna/meetings/m-1/audio.wav', startSec: 0, durationSec: 120 },
      ];
      installStubWithAssetUrls(() => wire);

      const chunks = await asChunksApi(adapter).getAudioChunks(toMeetingId('m-1'));

      expect(chunks.length).toBe(1);
      expect(chunks[0]).toEqual({
        url: 'asset://localhost//myna/meetings/m-1/audio.wav',
        startSec: 0,
        durationSec: 120,
      });
    });

    it('keeps the backend ordering untouched (no client-side sort)', async () => {
      const wire: readonly AudioChunkDto[] = [
        { path: '/m/audio.wav', startSec: 0, durationSec: 60 },
        { path: '/m/audio.part-0002.wav', startSec: 60, durationSec: 10 },
        { path: '/m/audio.part-0003.wav', startSec: 70, durationSec: 5 },
      ];
      installStubWithAssetUrls(() => wire);

      const chunks = await asChunksApi(adapter).getAudioChunks(toMeetingId('m-1'));

      expect(chunks.map((chunk) => chunk.url)).toEqual([
        'asset://localhost//m/audio.wav',
        'asset://localhost//m/audio.part-0002.wav',
        'asset://localhost//m/audio.part-0003.wav',
      ]);
    });

    it('resolves an empty array when the backend reports no chunks', async () => {
      installStubWithAssetUrls(() => []);

      const chunks = await asChunksApi(adapter).getAudioChunks(toMeetingId('m-1'));

      expect(chunks).toEqual([]);
    });

    it('rejects with the typed MeetingsError when the command fails', async () => {
      installStubWithAssetUrls(() => {
        throw { code: 'IO', message: 'cannot stat meeting dir' };
      });

      let caught: unknown;
      try {
        await asChunksApi(adapter).getAudioChunks(toMeetingId('m-1'));
      } catch (error) {
        caught = error;
      }

      expect(caught instanceof MeetingsError).toBe(true);
      if (caught instanceof MeetingsError) {
        expect(caught.code).toBe('IO');
        expect(caught.message).toBe('cannot stat meeting dir');
      }
    });
  });
});
