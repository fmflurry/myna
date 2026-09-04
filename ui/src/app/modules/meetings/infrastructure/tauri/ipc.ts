import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Observable } from 'rxjs';

import { MeetingsError, type MeetingsErrorCode } from '../../core/models/recording-state.model';
import type { AudioChunk } from '../../core/ports/audio-repository.port';
import type { CommandArgs, CommandName, CommandResult } from './commands';
import type { EventName, EventPayload } from './events';

/**
 * The ONLY file in `ui/src` allowed to import `@tauri-apps/api`. Every
 * other file reaches Tauri exclusively through {@link invokeCommand} and
 * {@link onEvent}, so the runtime dependency is fully swappable (e.g. for
 * headless specs) from a single seam.
 */

/** Every error code the Rust `AppError` taxonomy can produce. This is the
 * subset of {@link MeetingsErrorCode} that {@link mapIpcError} can ever
 * produce — it never returns the application-only `NOT_RECORDING` code. */
const KNOWN_ERROR_CODES: readonly MeetingsErrorCode[] = [
  'IO',
  'STORE',
  'STT',
  'LLM',
  'AUDIO',
  'NOT_FOUND',
  'BUSY',
  'MODELS_MISSING',
  'PATH',
  'UPDATER',
];

interface RawErrorEnvelope {
  readonly code: unknown;
  readonly message: unknown;
}

const hasErrorEnvelopeShape = (value: object): value is RawErrorEnvelope =>
  'code' in value && 'message' in value;

const isKnownErrorCode = (code: string): code is MeetingsErrorCode =>
  (KNOWN_ERROR_CODES as readonly string[]).includes(code);

/**
 * Narrows an `unknown` rejection from `invoke` into a {@link MeetingsError}
 * so the stable Rust error code survives the IPC seam all the way to the
 * facade. The Rust side always rejects with `{ code, message }` (see
 * `app/src-tauri/src/error.rs`), but this defends against any shape that
 * doesn't match — a raw string, a native `Error`, or a totally foreign
 * value — by falling back to the `UNKNOWN` code.
 */
export function mapIpcError(error: unknown): MeetingsError {
  if (typeof error === 'object' && error !== null && hasErrorEnvelopeShape(error)) {
    const { code, message } = error;
    if (typeof code === 'string' && typeof message === 'string') {
      return new MeetingsError(isKnownErrorCode(code) ? code : 'UNKNOWN', message);
    }
  }
  if (error instanceof Error) {
    return new MeetingsError('UNKNOWN', error.message);
  }
  return new MeetingsError('UNKNOWN', String(error));
}

/**
 * Invokes a frozen Tauri command by name, typed end-to-end via
 * {@link CommandArgs} / {@link CommandResult}. Rejects with a
 * {@link MeetingsError}, never a raw `unknown`.
 */
export async function invokeCommand<C extends CommandName>(
  name: C,
  args: CommandArgs<C>,
): Promise<CommandResult<C>> {
  try {
    return await invoke<CommandResult<C>>(name, args);
  } catch (error) {
    throw mapIpcError(error);
  }
}

/**
 * Subscribes to a frozen Tauri event by name, typed via
 * {@link EventPayload}. The `listen` `UnlistenFn` is invoked on teardown
 * so every subscription is cleaned up when the Observable is unsubscribed.
 */
export function onEvent<E extends EventName>(name: E): Observable<EventPayload<E>> {
  return new Observable((subscriber) => {
    let unlisten: (() => void) | undefined;
    let torndown = false;

    listen<EventPayload<E>>(name, (event: { payload: EventPayload<E> }) => subscriber.next(event.payload))
      .then((unlistenFn: () => void) => {
        if (torndown) {
          unlistenFn();
          return;
        }
        unlisten = unlistenFn;
      })
      .catch((error: unknown) => subscriber.error(mapIpcError(error)));

    return () => {
      torndown = true;
      unlisten?.();
    };
  });
}

/**
 * Returns a playable URL for a meeting's audio file, or null if none exists.
 * Invokes the Rust `get_meeting_audio_path` command and converts the filesystem
 * path to a Tauri asset URL via `convertFileSrc`.
 */
export async function getMeetingAudioUrl(meetingId: string): Promise<string | null> {
  const path = await invokeCommand('get_meeting_audio_path', { id: meetingId });
  return path !== null ? convertFileSrc(path) : null;
}

/**
 * Returns a meeting's ordered playable audio chunks for seamless multipart
 * WAV playback. Invokes the Rust `get_meeting_audio_chunks` command and
 * converts EVERY chunk path to a Tauri asset URL via `convertFileSrc`,
 * preserving the backend ordering (no client-side sort). Resolves to an
 * empty array when the meeting has no chunks; rejects with a
 * {@link MeetingsError} on command failure.
 */
export async function getMeetingAudioChunks(meetingId: string): Promise<readonly AudioChunk[]> {
  const chunks = await invokeCommand('get_meeting_audio_chunks', { id: meetingId });
  return chunks.map((chunk) => ({
    url: convertFileSrc(chunk.path),
    startSec: chunk.startSec,
    durationSec: chunk.durationSec,
  }));
}
