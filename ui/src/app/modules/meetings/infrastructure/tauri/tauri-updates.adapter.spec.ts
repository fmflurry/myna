import { TestBed } from '@angular/core/testing';

import type { UpdateCheckDto } from '../dto/update.dto';
import { installTauriInternalsStub, uninstallTauriInternalsStub } from './testing/tauri-internals.stub';
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
});
