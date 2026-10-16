import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AgentSession} from '@earendil-works/pi-coding-agent';
import type {DesktopExtensionUI} from '../src/dashboard/extension-ui.ts';
import {
  runReportCommand,
  type BugReportBundle,
  type ReportCommandContext,
  type ReportCommandDependencies,
  type ReportFile,
} from '../src/dashboard/report-commands.ts';

// Every external boundary is replaced: no gh, auth lookup, network, model call,
// filesystem export, crash-log mutation, or dependency on the user's settings.
function fixture(
  options: {
    destination?: 'auto' | 'gist' | 'radius';
    radiusConfigured?: boolean;
    confirms?: boolean[];
    choices?: Array<string | undefined>;
    description?: string;
    cancelEditor?: boolean;
    cancelProgress?: boolean;
  } = {},
) {
  const events: Array<{
    kind: string;
    title?: string;
    message?: string;
    data?: unknown;
  }> = [];
  const confirms = [...(options.confirms ?? [])];
  const choices = [...(options.choices ?? [])];
  const controller = new AbortController();
  const file: ReportFile = {
    name: 'session.jsonl',
    contentType: 'application/x-ndjson',
    data: 'SECRET TRANSCRIPT\n',
  };
  const notifications: Array<{message: string; type?: string}> = [];
  let onShow: ((title: string) => void) | undefined;
  let onUpload: ((signal: AbortSignal) => Promise<string>) | undefined;
  const session = {
    settingsManager: {
      getSessionShareDestination: () => options.destination ?? 'auto',
    },
    modelRuntime: {
      getProviderAuthStatus: () => ({
        configured: options.radiusConfigured ?? false,
      }),
    },
    sessionManager: {getCwd: () => '/workspace'},
    model: {name: 'Test model', provider: 'test-provider'},
    summarizeForBugReport: async (args: {
      hint?: string;
      signal: AbortSignal;
    }) => {
      events.push({kind: 'summary', data: args});
      return 'GENERATED SUMMARY WITH SENSITIVE PATH';
    },
  } as unknown as AgentSession;
  const ui = {
    show: async (title: string, message: string) => {
      events.push({kind: 'show', title, message});
      onShow?.(title);
    },
    select: async (title: string, values: string[], args: unknown) => {
      events.push({kind: 'select', title, data: {values, args}});
      assert.ok(choices.length, `Unexpected selection: ${title}`);
      return choices.shift();
    },
    context: {
      confirm: async (
        title: string,
        message: string,
        args?: {signal?: AbortSignal},
      ) => {
        events.push({kind: 'confirm', title, message});
        if (title.endsWith('…')) {
          if (options.cancelProgress) return false;
          return new Promise<boolean>(resolve => {
            if (args?.signal?.aborted) resolve(false);
            else
              args?.signal?.addEventListener('abort', () => resolve(false), {
                once: true,
              });
          });
        }
        assert.ok(confirms.length, `Unexpected confirmation: ${title}`);
        return confirms.shift()!;
      },
      editor: async (title: string, prefill: string) => {
        events.push({kind: 'editor', title, message: prefill});
        return options.cancelEditor
          ? undefined
          : (options.description ?? prefill);
      },
      notify: (message: string, type?: string) => {
        notifications.push({message, type});
      },
      setStatus: (key: string, text?: string) => {
        events.push({kind: 'status', title: key, message: text});
      },
    },
  } as unknown as DesktopExtensionUI;
  const deps: ReportCommandDependencies = {
    sharePayload: async (_session, destination) => {
      events.push({kind: 'sharePayload', data: destination});
      return file;
    },
    shareUpload: async (_session, destination, payload, signal) => {
      events.push({kind: 'shareUpload', data: {destination, payload, signal}});
      return onUpload ? onUpload(signal) : 'https://example.test/shared';
    },
    bugBundle: async (_session, args, summary) => {
      events.push({kind: 'bugBundle', data: {args, summary}});
      return {
        metadata: {
          id: 'report-id',
          createdAt: 'now',
          hint: args.hint ?? null,
          session: {
            included: args.includeSession,
            summaryIncluded: summary !== undefined,
          },
        },
        diagnostics: {crashes: [{message: 'SENSITIVE CRASH'}]},
        sessionJsonl: args.includeSession ? file.data : undefined,
        summary,
      };
    },
    bugFiles: async bundle => {
      events.push({kind: 'bugFiles', data: bundle});
      const files = [
        {
          name: 'report.json',
          contentType: 'application/json',
          data: JSON.stringify(bundle.metadata),
        },
        {
          name: 'diagnostics.json',
          contentType: 'application/json',
          data: JSON.stringify(bundle.diagnostics),
        },
      ];
      if (bundle.sessionJsonl !== undefined)
        files.push({...file, data: bundle.sessionJsonl});
      if (bundle.summary !== undefined)
        files.push({
          name: 'summary.md',
          contentType: 'text/markdown',
          data: bundle.summary,
        });
      return files;
    },
    bugGateway: async () => 'https://bug-gateway.test',
    uploadBug: async (_session, bundle, signal, gateway) => {
      events.push({kind: 'uploadBug', data: {bundle, signal, gateway}});
      return onUpload ? onUpload(signal) : 'server-report-id';
    },
    exportBug: async (bundle, path) => {
      events.push({kind: 'exportBug', data: {bundle, path}});
    },
    recordBug: async (_session, bundle, delivery) => {
      events.push({kind: 'recordBug', data: {bundle, delivery}});
    },
    readChangelog: async () => '# Bundled Pi changelog\nRelease notes.',
    offline: () => false,
  };
  const context: ReportCommandContext = {
    session,
    ui,
    signal: controller.signal,
    dependencies: deps,
  };
  return {
    context,
    deps,
    events,
    notifications,
    controller,
    file,
    onShow(callback: (title: string) => void) {
      onShow = callback;
    },
    onUpload(callback: (signal: AbortSignal) => Promise<string>) {
      onUpload = callback;
    },
    run(name: string, args = '') {
      return runReportCommand(name, args, context);
    },
  };
}

function kinds(f: ReturnType<typeof fixture>, kind: string) {
  return f.events.filter(event => event.kind === kind);
}
function assertCleanProgress(f: ReturnType<typeof fixture>) {
  const statuses = kinds(f, 'status');
  assert.ok(statuses.length >= 2);
  assert.equal(statuses.at(-1)?.message, undefined);
}

void test('unhandled commands do nothing and return false', async () => {
  const f = fixture();
  assert.equal(await f.run('export'), false);
  assert.deepEqual(f.events, []);
});

void test('share and changelog reject unexpected arguments before IO', async () => {
  for (const name of ['share', 'changelog']) {
    const f = fixture();
    assert.equal(await f.run(name, 'unexpected'), true);
    assert.deepEqual(f.events, []);
    assert.equal(f.notifications[0].message, `Usage: /${name}`);
    assert.equal(f.notifications[0].type, 'error');
  }
});

void test('bare /share never uploads without both explicit confirmations', async () => {
  for (const confirms of [[false], [true, false]]) {
    const f = fixture({confirms});
    assert.equal(await f.run('share'), true);
    assert.equal(kinds(f, 'shareUpload').length, 0);
    assert.equal(
      kinds(f, 'sharePayload').length,
      confirms.length === 1 ? 0 : 1,
    );
    assert.equal(f.notifications.at(-1)?.type, 'info');
  }
});

void test('share reviews exact payload, warns secret gists are not private, then uploads once', async () => {
  const f = fixture({confirms: [true, true]});
  await f.run('share');
  assert.match(kinds(f, 'confirm')[0].message!, /NOT private/);
  const review = f.events.findIndex(
    event => event.title === 'Review session.jsonl',
  );
  const consent = f.events.findIndex(
    event => event.title === 'Upload reviewed session?',
  );
  const upload = f.events.findIndex(event => event.kind === 'shareUpload');
  assert.ok(review < consent && consent < upload);
  assert.equal(f.events[review].message, f.file.data);
  assert.deepEqual(
    (f.events[upload].data as {payload: ReportFile}).payload,
    f.file,
  );
  assert.equal(
    (f.events[upload].data as {destination: string}).destination,
    'gist',
  );
  assert.match(
    kinds(f, 'show').at(-1)?.message ?? '',
    /https:\/\/example.test\/shared/,
  );
  assertCleanProgress(f);
});

void test('large share payloads are reviewed without truncation before upload', async () => {
  const f = fixture({confirms: [true, true]});
  f.file.data = 'x'.repeat(239999) + '🔒' + 'SENSITIVE DATA\n'.repeat(50000);
  await f.run('share');
  const pages = kinds(f, 'show').filter(event =>
    event.title?.startsWith('Review session.jsonl'),
  );
  assert.ok(pages.length > 1);
  assert.equal(pages.map(event => event.message).join(''), f.file.data);
  assert.ok(pages.every(event => event.message!.length <= 240000));
  assert.equal(pages[0].message!.length, 239999);
  assert.ok(pages[1].message!.startsWith('🔒'));
  assert.equal(kinds(f, 'shareUpload').length, 1);
});

void test('share respects forced destinations and configured Radius auto selection', async () => {
  for (const [destination, radiusConfigured, expected] of [
    ['auto', true, 'radius'],
    ['radius', false, 'radius'],
    ['gist', true, 'gist'],
  ] as const) {
    const f = fixture({destination, radiusConfigured, confirms: [true, true]});
    await f.run('share');
    assert.equal(kinds(f, 'sharePayload')[0].data, expected);
    if (expected === 'radius')
      assert.match(
        kinds(f, 'confirm')[0].message!,
        /organization-visible.*Radius/,
      );
  }
});

void test('share failures never silently switch destination or retry and clean progress', async () => {
  const f = fixture({destination: 'radius', confirms: [true, true]});
  f.onUpload(async () => {
    throw new Error('Radius failed');
  });
  await f.run('share');
  assert.equal(kinds(f, 'shareUpload').length, 1);
  assert.match(f.notifications.at(-1)?.message ?? '', /Radius failed/);
  assert.equal(f.notifications.at(-1)?.type, 'error');
  assertCleanProgress(f);
});

void test('native progress cancellation aborts the upload and does not report a link', async () => {
  const f = fixture({confirms: [true, true], cancelProgress: true});
  let uploadSignal: AbortSignal | undefined;
  f.onUpload(signal => {
    uploadSignal = signal;
    return new Promise((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), {
        once: true,
      }),
    );
  });
  await f.run('share');
  assert.ok(uploadSignal?.aborted);
  assert.equal(
    kinds(f, 'show').some(event => event.title === 'Session shared'),
    false,
  );
  assert.equal(f.notifications.at(-1)?.type, 'info');
  assertCleanProgress(f);
});

void test('session lifecycle abort during review prevents final upload', async () => {
  const f = fixture({confirms: [true]});
  f.onShow(title => {
    if (title.startsWith('Review')) f.controller.abort();
  });
  await f.run('share');
  assert.equal(kinds(f, 'shareUpload').length, 0);
});

void test('native Stop during upload aborts and never reopens dialogs or publishes success', async () => {
  for (const name of ['share', 'bug']) {
    const f = fixture({
      confirms: name === 'share' ? [true, true] : [true],
      choices: name === 'bug' ? ['No', 'No', 'Upload Report'] : [],
    });
    let uploadSignal: AbortSignal | undefined;
    let eventCountAtStop = 0;
    f.onUpload(signal => {
      uploadSignal = signal;
      queueMicrotask(() => {
        eventCountAtStop = f.events.length;
        f.controller.abort();
      });
      return new Promise(() => {});
    });
    await f.run(name);
    assert.ok(uploadSignal?.aborted);
    assert.ok(
      f.events.slice(eventCountAtStop).every(event => event.kind === 'status'),
    );
    assert.equal(kinds(f, 'recordBug').length, 0);
    assert.equal(kinds(f, 'exportBug').length, 0);
    assertCleanProgress(f);
  }
});

void test('offline share has no export, authentication or upload operations', async () => {
  const f = fixture();
  f.deps.offline = () => true;
  await f.run('share');
  assert.deepEqual(f.events, []);
  assert.match(f.notifications[0].message, /online mode/);
});

void test('bug report defaults to no transcript or summary, and reviews diagnostics before explicit consent', async () => {
  const f = fixture({choices: ['No', 'No', 'Upload Report'], confirms: [true]});
  await f.run('bug', 'original hint');
  assert.equal(kinds(f, 'editor')[0].message, 'original hint');
  assert.equal(kinds(f, 'summary').length, 0);
  const {args, summary} = kinds(f, 'bugBundle')[0].data as {
    args: {hint: string; includeSession: boolean};
    summary?: string;
  };
  assert.deepEqual(args, {hint: 'original hint', includeSession: false});
  assert.equal(summary, undefined);
  const shown = kinds(f, 'show');
  assert.match(shown[0].message!, /private report.*Pi developers/);
  assert.match(shown[0].message!, /crash/);
  assert.match(
    shown.find(event => event.title === 'Review diagnostics.json')!.message!,
    /SENSITIVE CRASH/,
  );
  assert.equal(
    shown.some(event => event.title === 'Review session.jsonl'),
    false,
  );
  const review = f.events.findIndex(
    event => event.title === 'Review diagnostics.json',
  );
  const consent = f.events.findIndex(
    event => event.title === 'Send private bug report?',
  );
  const upload = f.events.findIndex(event => event.kind === 'uploadBug');
  assert.ok(review < consent && consent < upload);
  assert.match(
    f.events[consent].message!,
    /https:\/\/bug-gateway.test\/v1\/bug-reports/,
  );
  assert.equal(
    (kinds(f, 'uploadBug')[0].data as {gateway: string}).gateway,
    'https://bug-gateway.test',
  );
  assert.equal(kinds(f, 'recordBug').length, 1);
  assert.match(f.notifications[0].message, /Report ID: server-report-id/);
  assertCleanProgress(f);
});

void test('bug transcript opt-in reviews complete transcript and never invokes a summary', async () => {
  const f = fixture({
    choices: ['Yes, include the transcript', 'Upload Report'],
    confirms: [true],
  });
  await f.run('bug');
  assert.equal(kinds(f, 'summary').length, 0);
  assert.equal(
    kinds(f, 'show').find(event => event.title === 'Review session.jsonl')
      ?.message,
    f.file.data,
  );
  const {bundle} = kinds(f, 'uploadBug')[0].data as {bundle: BugReportBundle};
  assert.equal(bundle.metadata.session.included, true);
  assert.equal(bundle.sessionJsonl, f.file.data);
});

void test('summary generation is separately opted into with provider and token disclosure, then reviewed', async () => {
  const f = fixture({
    choices: ['No', 'Yes, generate a summary', 'Upload Report'],
    confirms: [true],
  });
  await f.run('bug', 'hint');
  const choice = kinds(f, 'select').find(
    event => event.title === 'Generate a summary instead?',
  )!;
  const args = (choice.data as {args: {message: string; selected: string}})
    .args;
  assert.equal(args.selected, 'No');
  assert.match(args.message, /test-provider.*credentials and tokens/);
  assert.match(args.message, /may incur cost/);
  assert.equal(kinds(f, 'summary').length, 1);
  assert.match(
    kinds(f, 'show').find(event => event.title === 'Review summary.md')
      ?.message ?? '',
    /GENERATED SUMMARY/,
  );
  const {bundle} = kinds(f, 'uploadBug')[0].data as {bundle: BugReportBundle};
  assert.equal(bundle.sessionJsonl, undefined);
  assert.equal(bundle.metadata.session.summaryIncluded, true);
  assertCleanProgress(f);
});

void test('cancelling bug editor, inclusion selection, delivery or final consent never sends a report', async () => {
  const fixtures = [
    fixture({cancelEditor: true}),
    fixture({choices: [undefined]}),
    fixture({choices: ['No', 'No', 'Cancel']}),
    fixture({choices: ['No', 'No', 'Upload Report'], confirms: [false]}),
  ];
  for (const f of fixtures) {
    await f.run('bug');
    assert.equal(kinds(f, 'uploadBug').length, 0);
    assert.equal(kinds(f, 'exportBug').length, 0);
    assert.equal(kinds(f, 'recordBug').length, 0);
  }
});

void test('zip delivery remains local, is confirmed, and records its path', async () => {
  const f = fixture({choices: ['No', 'No', 'Export as Zip'], confirms: [true]});
  f.deps.offline = () => true;
  await f.run('bug');
  assert.equal(kinds(f, 'uploadBug').length, 0);
  const exported = kinds(f, 'exportBug')[0].data as {path: string};
  assert.equal(exported.path, '/workspace/pi-bug-report-report-id.zip');
  assert.match(kinds(f, 'confirm')[0].message!, /Nothing will be uploaded/);
  assert.deepEqual(
    (kinds(f, 'recordBug')[0].data as {delivery: unknown}).delivery,
    {delivery: 'zip', path: exported.path},
  );
});

void test('failed bug upload offers a confirmed local zip, never a public issue or automatic retry', async () => {
  const f = fixture({
    choices: ['No', 'No', 'Upload Report', 'Export as Zip'],
    confirms: [true, true],
  });
  f.onUpload(async () => {
    throw new Error('test upload failed');
  });
  await f.run('bug');
  assert.equal(kinds(f, 'uploadBug').length, 1);
  assert.equal(kinds(f, 'exportBug').length, 1);
  assert.equal(kinds(f, 'recordBug').length, 1);
  assertCleanProgress(f);
});

void test('receipt failure after successful upload does not trigger duplicate upload or export', async () => {
  const f = fixture({choices: ['No', 'No', 'Upload Report'], confirms: [true]});
  f.deps.recordBug = async () => {
    throw new Error('receipt failed');
  };
  await f.run('bug');
  assert.equal(kinds(f, 'uploadBug').length, 1);
  assert.equal(kinds(f, 'exportBug').length, 0);
  assert.match(
    f.notifications.at(-1)?.message ?? '',
    /Report delivered.*receipt/,
  );
  assert.equal(f.notifications.at(-1)?.type, 'warning');
});

void test('offline bug upload and summary generation cannot reach external operations', async () => {
  for (const choices of [
    ['No', 'No', 'Upload Report'],
    ['No', 'Yes, generate a summary'],
  ]) {
    const f = fixture({choices});
    f.deps.offline = () => true;
    await f.run('bug');
    assert.equal(kinds(f, 'uploadBug').length, 0);
    assert.equal(kinds(f, 'summary').length, 0);
    assert.equal(f.notifications.at(-1)?.type, 'error');
  }
});

void test('bug upload cancellation aborts without recording or offering export', async () => {
  const f = fixture({
    choices: ['No', 'No', 'Upload Report'],
    confirms: [true],
    cancelProgress: true,
  });
  let signal: AbortSignal | undefined;
  f.onUpload(value => {
    signal = value;
    return new Promise(() => {});
  });
  await f.run('bug');
  assert.ok(signal?.aborted);
  assert.equal(kinds(f, 'recordBug').length, 0);
  assert.equal(kinds(f, 'exportBug').length, 0);
  assert.equal(f.notifications.at(-1)?.type, 'info');
  assertCleanProgress(f);
});

void test('changelog reads its bundled content into readonly dialogs, including all large-file chunks', async () => {
  const f = fixture();
  const changelog = '# Changelog\n' + 'version notes\n'.repeat(40000);
  f.deps.readChangelog = async () => changelog;
  assert.equal(await f.run('changelog'), true);
  assert.equal(
    kinds(f, 'show')
      .map(event => event.message)
      .join(''),
    changelog,
  );
  assert.ok(kinds(f, 'show').every(event => event.message!.length <= 240000));
  assert.equal(kinds(f, 'editor').length, 0);
  assert.equal(
    kinds(f, 'shareUpload').length + kinds(f, 'uploadBug').length,
    0,
  );
});

void test('changelog read failure is handled without an editable placeholder', async () => {
  const f = fixture();
  f.deps.readChangelog = async () => {
    throw new Error('bundled changelog unavailable');
  };
  assert.equal(await f.run('changelog'), true);
  assert.equal(f.events.length, 0);
  assert.match(f.notifications[0].message, /bundled changelog unavailable/);
});
