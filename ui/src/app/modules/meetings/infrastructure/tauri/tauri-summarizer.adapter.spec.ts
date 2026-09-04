import { TestBed } from '@angular/core/testing';

import { toMeetingId } from '../../core/models/meeting.model';
import {
  flushMicrotasks,
  installTauriInternalsStub,
  uninstallTauriInternalsStub,
} from './testing/tauri-internals.stub';
import { TauriSummarizerAdapter } from './tauri-summarizer.adapter';

describe('TauriSummarizerAdapter', () => {
  let adapter: TauriSummarizerAdapter;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [TauriSummarizerAdapter] });
    adapter = TestBed.inject(TauriSummarizerAdapter);
  });

  afterEach(() => uninstallTauriInternalsStub());

  it('summarize() sends the template name and language, and maps the returned SummaryDto', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return { template: 'key-points', markdown: '# Key Points', createdAt: '2026-01-15T10:00:00Z', language: 'fr' };
    });

    const summary = await adapter.summarize(
      toMeetingId('m-1'),
      { name: 'key-points', description: 'desc', prompt: 'prompt' },
      'fr',
    );

    expect(receivedArgs).toEqual({ meetingId: 'm-1', template: 'key-points', language: 'fr' });
    expect(summary.markdown).toBe('# Key Points');
    expect(summary.language).toBe('fr');
  });

  it('summarize() omits language from the invoke args when not given', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return { template: 'key-points', markdown: '# Key Points', createdAt: '2026-01-15T10:00:00Z', language: 'en' };
    });

    await adapter.summarize(toMeetingId('m-1'), { name: 'key-points', description: 'desc', prompt: 'prompt' });

    expect(receivedArgs).toEqual({ meetingId: 'm-1', template: 'key-points' });
  });

  it('listLanguages() maps every SummaryLanguageDto to the domain shape', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return [
        { code: 'en', label: 'English' },
        { code: 'fr', label: 'French' },
      ];
    });

    const languages = await adapter.listLanguages();

    expect(receivedCmd).toBe('list_summary_languages');
    expect(languages).toEqual([
      { code: 'en', label: 'English' },
      { code: 'fr', label: 'French' },
    ]);
  });

  it('tokens() maps the summary://token event payload', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: unknown[] = [];
    adapter.tokens().subscribe((token) => results.push(token));
    await flushMicrotasks();

    stub.emit('summary://token', { meetingId: 'm-1', template: 'key-points', token: 'foo' });

    expect(results).toEqual([{ meetingId: toMeetingId('m-1'), template: 'key-points', token: 'foo' }]);
  });

  it('done() maps the summary://done event payload, stamping a receipt-time createdAt', async () => {
    const stub = installTauriInternalsStub((cmd) => {
      throw new Error(`unexpected command '${cmd}'`);
    });

    const results: { template: string; markdown: string; createdAt: Date; language: string }[] = [];
    adapter.done().subscribe((summary) => results.push(summary));
    await flushMicrotasks();

    stub.emit('summary://done', { meetingId: 'm-1', template: 'key-points', markdown: '# Done', language: 'fr' });

    expect(results.length).toBe(1);
    expect(results[0]?.template).toBe('key-points');
    expect(results[0]?.markdown).toBe('# Done');
    expect(results[0]?.createdAt).toBeInstanceOf(Date);
    expect(results[0]?.language).toBe('fr');
  });

  it('cancel() invokes cancel_summarization', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return undefined;
    });

    await adapter.cancel();

    expect(receivedCmd).toBe('cancel_summarization');
  });

  it('getSummary() sends meetingId, template and language, and maps a non-null result', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return { template: 'key-points', markdown: '# Key Points', createdAt: '2026-01-15T10:00:00Z', language: 'en' };
    });

    const summary = await adapter.getSummary(toMeetingId('m-1'), 'key-points', 'en');

    expect(receivedArgs).toEqual({ meetingId: 'm-1', template: 'key-points', language: 'en' });
    expect(summary?.markdown).toBe('# Key Points');
  });

  it('getSummary() resolves null when the command resolves null', async () => {
    installTauriInternalsStub(() => null);

    const summary = await adapter.getSummary(toMeetingId('m-1'), 'key-points', 'en');

    expect(summary).toBeNull();
  });

  it('editSummary() invokes edit_summary with camelCase args and maps the returned SummaryDto', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return { template: 'key-points', markdown: '# Edited', createdAt: '2026-01-15T10:00:00Z', language: 'en' };
    });

    const summary = await adapter.editSummary(toMeetingId('m-1'), 'key-points', 'en', '# Edited');

    expect(receivedCmd).toBe('edit_summary');
    expect(receivedArgs).toEqual({ meetingId: 'm-1', template: 'key-points', language: 'en', markdown: '# Edited' });
    expect(summary.markdown).toBe('# Edited');
    expect(summary.createdAt).toEqual(new Date('2026-01-15T10:00:00Z'));
    expect(summary.language).toBe('en');
  });

  it('summarize() sends instructions as { specific, includeGeneral } when given', async () => {
    let receivedArgs: unknown;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args;
      return { template: 'key-points', markdown: '# Key Points', createdAt: '2026-01-15T10:00:00Z', language: 'en' };
    });

    await adapter.summarize(
      toMeetingId('m-1'),
      { name: 'key-points', description: 'desc', prompt: 'prompt' },
      'en',
      { text: 'focus on decisions', includeGeneral: false },
    );

    expect(receivedArgs).toEqual({
      meetingId: 'm-1',
      template: 'key-points',
      language: 'en',
      instructions: { specific: 'focus on decisions', includeGeneral: false },
    });
  });

  it('summarize() omits the instructions key entirely when no draft is given', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    installTauriInternalsStub((_cmd, args) => {
      receivedArgs = args as Record<string, unknown>;
      return { template: 'key-points', markdown: '# Key Points', createdAt: '2026-01-15T10:00:00Z', language: 'en' };
    });

    await adapter.summarize(toMeetingId('m-1'), { name: 'key-points', description: 'desc', prompt: 'prompt' }, 'en');

    expect(receivedArgs).toEqual({ meetingId: 'm-1', template: 'key-points', language: 'en' });
    // toEqual ignores undefined-valued keys, so pin the exact key set: a
    // present-but-undefined `instructions` — which the conditional spread
    // must prevent — fails here.
    expect(Object.keys(receivedArgs ?? {})).toEqual(['meetingId', 'template', 'language']);
  });

  it('getGuidelines() invokes get_summary_guidelines and returns the raw string', async () => {
    let receivedCmd: string | undefined;
    installTauriInternalsStub((cmd) => {
      receivedCmd = cmd;
      return 'Always list action items.';
    });

    const guidelines = await adapter.getGuidelines();

    expect(receivedCmd).toBe('get_summary_guidelines');
    expect(guidelines).toBe('Always list action items.');
  });

  it('setGuidelines() invokes set_summary_guidelines with the guidelines arg', async () => {
    let receivedCmd: string | undefined;
    let receivedArgs: unknown;
    installTauriInternalsStub((cmd, args) => {
      receivedCmd = cmd;
      receivedArgs = args;
      return undefined;
    });

    await adapter.setGuidelines('Focus on decisions.');

    expect(receivedCmd).toBe('set_summary_guidelines');
    expect(receivedArgs).toEqual({ guidelines: 'Focus on decisions.' });
  });
});
