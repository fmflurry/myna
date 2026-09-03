import { TestBed } from '@angular/core/testing';

import type { UpdateInstallDone, UpdateInstallProgress } from '../../core/ports/updates.port';
import type { UpdateCheckDto } from '../dto/update.dto';
import type { UpdateInstallResultDto } from './commands';
import type { UpdateProgressWireDto } from './events';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriUpdatesAdapter } from './tauri-updates.adapter';

describe('TauriUpdatesAdapter', () => {
  let adapter: TauriUpdatesAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriUpdatesAdapter] });
    adapter = TestBed.inject(TauriUpdatesAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  describe('consent()', () => {
    it('invokes update_consent and returns the raw consent value', async () => {
      let receivedCmd: string | undefined;
      installTauriInternalsStub((cmd) => {
        receivedCmd = cmd;
        return 'granted';
      });

      const consent = await adapter.consent();

      expect(receivedCmd).toBe('update_consent');
      expect(consent).toBe('granted');
    });
  });

  describe('setConsent()', () => {
    it('invokes set_update_consent with the consent argument', async () => {
      let receivedCmd: string | undefined;
      let receivedArgs: unknown;
      installTauriInternalsStub((cmd, args) => {
        receivedCmd = cmd;
        receivedArgs = args;
        return null;
      });

      await adapter.setConsent('declined');

      expect(receivedCmd).toBe('set_update_consent');
      expect(receivedArgs).toEqual({ consent: 'declined' });
    });
  });

  describe('check()', () => {
    it('invokes check_for_update with the manual argument', async () => {
      let receivedCmd: string | undefined;
      let receivedArgs: unknown;
      installTauriInternalsStub((cmd, args) => {
        receivedCmd = cmd;
        receivedArgs = args;
        return { status: 'up-to-date' } satisfies UpdateCheckDto;
      });

      await adapter.check(true);

      expect(receivedCmd).toBe('check_for_update');
      expect(receivedArgs).toEqual({ manual: true });
    });

    it('maps an up-to-date DTO to the up-to-date domain variant', async () => {
      installTauriInternalsStub(() => ({ status: 'up-to-date' }) satisfies UpdateCheckDto);

      const check = await adapter.check(false);

      expect(check).toEqual({ status: 'up-to-date' });
    });

    it('maps an available DTO to the available domain variant', async () => {
      installTauriInternalsStub(
        () =>
          ({
            status: 'available',
            version: '1.2.3',
            notes: 'Bug fixes',
            downloadUrl: 'https://example.com/1.2.3',
          }) satisfies UpdateCheckDto,
      );

      const check = await adapter.check(false);

      expect(check).toEqual({
        status: 'available',
        version: '1.2.3',
        notes: 'Bug fixes',
        downloadUrl: 'https://example.com/1.2.3',
      });
    });

    it('maps a skipped DTO to the skipped domain variant, carrying the reason', async () => {
      installTauriInternalsStub(
        () => ({ status: 'skipped', reason: 'throttled' }) satisfies UpdateCheckDto,
      );

      const check = await adapter.check(false);

      expect(check).toEqual({ status: 'skipped', reason: 'throttled' });
    });

    it('maps a failed DTO to the failed domain variant, carrying the message', async () => {
      installTauriInternalsStub(
        () => ({ status: 'failed', message: 'network unreachable' }) satisfies UpdateCheckDto,
      );

      const check = await adapter.check(false);

      expect(check).toEqual({ status: 'failed', message: 'network unreachable' });
    });

    it('maps an unrecognized status to the failed domain variant instead of throwing', async () => {
      installTauriInternalsStub(() => ({ status: 'from-the-future' }) as unknown as UpdateCheckDto);

      const check = await adapter.check(false);

      expect(check.status).toBe('failed');
    });
  });

  describe('install()', () => {
    // The resolve shape below is NOT invented: it is the serde output of
    // Rust's `UpdateDonePayload` (camelCase, all keys present, nulls
    // included) — the command resolves with the exact payload it emits on
    // `update://done`, pinned by
    // `install_update_resolves_with_the_done_payload` and
    // `update_event_payloads_use_the_documented_camel_case_wire_shape` in
    // `app/src-tauri/src/commands/update_install.rs`. An earlier spec
    // mocked a DTO the Rust never returned; this one mirrors the wire.
    it('invokes install_update with no args and maps the result DTO to the domain', async () => {
      let receivedCmd: string | undefined;
      let receivedArgs: unknown;
      installTauriInternalsStub((cmd, args) => {
        receivedCmd = cmd;
        receivedArgs = args;
        return { success: true, version: '2.0.0', message: null } satisfies UpdateInstallResultDto;
      });

      const result = await adapter.install();

      expect(receivedCmd).toBe('install_update');
      expect(receivedArgs).toEqual({});
      expect(result).toEqual({ success: true, version: '2.0.0', message: null });
    });

    it('maps the up-to-date no-op terminal exactly as Rust sends it', async () => {
      installTauriInternalsStub(
        () => ({ success: true, version: null, message: 'up-to-date' }) satisfies UpdateInstallResultDto,
      );

      const result = await adapter.install();

      expect(result).toEqual({ success: true, version: null, message: 'up-to-date' });
    });

    it('degrades non-string version/message to null and non-true success to false', async () => {
      installTauriInternalsStub(
        () => ({ success: 'yes', version: 42 }) as unknown as UpdateInstallResultDto,
      );

      const result = await adapter.install();

      expect(result).toEqual({ success: false, version: null, message: null });
    });
  });

  describe('restart()', () => {
    it('invokes restart_app with no args', async () => {
      let receivedCmd: string | undefined;
      let receivedArgs: unknown;
      installTauriInternalsStub((cmd, args) => {
        receivedCmd = cmd;
        receivedArgs = args;
        return null;
      });

      await adapter.restart();

      expect(receivedCmd).toBe('restart_app');
      expect(receivedArgs).toEqual({});
    });
  });

  describe('installProgress()', () => {
    it('maps update://progress payloads', async () => {
      const stub = installTauriInternalsStub(() => null);
      const seen: UpdateInstallProgress[] = [];
      const subscription = adapter.installProgress().subscribe((progress) => seen.push(progress));
      await flushMicrotasks();

      stub.emit('update://progress', { downloadedBytes: 30, totalBytes: 100, percent: 30 });
      expect(seen).toEqual([{ downloadedBytes: 30, totalBytes: 100, percent: 30 }]);

      subscription.unsubscribe();
    });

    it('clamps percent into 0..100', async () => {
      const stub = installTauriInternalsStub(() => null);
      const seen: UpdateInstallProgress[] = [];
      const subscription = adapter.installProgress().subscribe((progress) => seen.push(progress));
      await flushMicrotasks();

      stub.emit('update://progress', { downloadedBytes: 150, totalBytes: 100, percent: 150 });
      stub.emit('update://progress', { downloadedBytes: -5, totalBytes: 100, percent: -20 });
      expect(seen.map((progress) => progress.percent)).toEqual([100, 0]);

      subscription.unsubscribe();
    });

    it('computes percent from the byte counters when the payload omits percent', async () => {
      const stub = installTauriInternalsStub(() => null);
      const seen: UpdateInstallProgress[] = [];
      const subscription = adapter.installProgress().subscribe((progress) => seen.push(progress));
      await flushMicrotasks();

      stub.emit('update://progress', {
        downloadedBytes: 25,
        totalBytes: 100,
      } as unknown as UpdateProgressWireDto);
      expect(seen).toEqual([{ downloadedBytes: 25, totalBytes: 100, percent: 25 }]);

      subscription.unsubscribe();
    });

    it('passes an indeterminate (percent: null) tick through as null — never 0', async () => {
      // FIX 3: Rust sends `percent: null` (and `totalBytes: null`) when
      // Content-Length is absent. Coercing that to 0 fabricates a real
      // 0% download; the UI must see null and render indeterminate.
      const stub = installTauriInternalsStub(() => null);
      const seen: UpdateInstallProgress[] = [];
      const subscription = adapter.installProgress().subscribe((progress) => seen.push(progress));
      await flushMicrotasks();

      stub.emit('update://progress', { downloadedBytes: 4096, totalBytes: null, percent: null });
      expect(seen).toEqual([{ downloadedBytes: 4096, totalBytes: 0, percent: null }]);

      subscription.unsubscribe();
    });

    it('degrades an unknown payload shape to indeterminate progress, never a fake 0%', async () => {
      const stub = installTauriInternalsStub(() => null);
      const seen: UpdateInstallProgress[] = [];
      const subscription = adapter.installProgress().subscribe((progress) => seen.push(progress));
      await flushMicrotasks();

      stub.emit('update://progress', { downloadedBytes: 'lots' });
      expect(seen).toEqual([{ downloadedBytes: 0, totalBytes: 0, percent: null }]);

      subscription.unsubscribe();
    });
  });

  describe('installDone()', () => {
    it('maps update://done payloads', async () => {
      const stub = installTauriInternalsStub(() => null);
      const seen: UpdateInstallDone[] = [];
      const subscription = adapter.installDone().subscribe((done) => seen.push(done));
      await flushMicrotasks();

      stub.emit('update://done', { success: true, version: '2.0.0', message: null });
      expect(seen).toEqual([{ success: true, version: '2.0.0', message: null }]);

      subscription.unsubscribe();
    });

    it('degrades an unknown payload shape to a safe failure', async () => {
      const stub = installTauriInternalsStub(() => null);
      const seen: UpdateInstallDone[] = [];
      const subscription = adapter.installDone().subscribe((done) => seen.push(done));
      await flushMicrotasks();

      stub.emit('update://done', { success: 'truthy-string' });
      expect(seen).toEqual([{ success: false, version: null, message: null }]);

      subscription.unsubscribe();
    });
  });
});
