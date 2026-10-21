import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, normalize, win32} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import vm from 'node:vm';
import {readMarkdownFile} from '../src/dashboard/markdown-files.ts';
import {
  externalLinkURL,
  fileLinkParts,
  fileLinkPath,
} from '../assets/dashboard/file-links.js';
import {
  openConversationFile,
  openConversationURL,
} from '../src/desktop/files.ts';

void test('conversation link parsing preserves text, local links and angle targets', () => {
  assert.deepEqual(
    fileLinkParts(
      'See [My%20file](<src/a (copy).ts>) and file:///tmp/report.txt\n[web](https://example.com).',
    ),
    [
      {text: 'See '},
      {text: 'My file', path: 'src/a (copy).ts'},
      {text: ' and '},
      {text: 'report.txt', path: '/tmp/report.txt'},
      {text: '\n'},
      {text: 'web', url: 'https://example.com/'},
      {text: '.'},
    ],
  );
  assert.deepEqual(fileLinkParts('unfinished [label](file.txt'), [
    {text: 'unfinished [label](file.txt'},
  ]);
  assert.deepEqual(fileLinkParts('[first\nsecond](file.txt)'), [
    {text: '[first\nsecond](file.txt)'},
  ]);
});

void test(
  'long unfinished link delimiters do not stall conversation rendering',
  {timeout: 2000},
  () => {
    const unfinished = '['.repeat(100_000) + '\n' + '[label]('.repeat(20_000);
    assert.deepEqual(fileLinkParts(unfinished + '\nfile:///tmp/done.txt'), [
      {text: unfinished + '\n'},
      {text: 'done.txt', path: '/tmp/done.txt'},
    ]);
  },
);

void test('conversation links decode filenames once and open the selected project file', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'varisdev-links-'));
  t.after(() => rm(cwd, {recursive: true, force: true}));
  const name = 'Play Instant Action #100%.command';
  const path = join(cwd, name);
  await writeFile(path, 'example');
  const decoded = fileLinkPath(pathToFileURL(path).href);
  assert.ok(decoded);
  assert.equal(normalize(decoded), path);
  assert.equal(fileLinkPath(encodeURIComponent(name)), name);
  assert.equal(
    fileLinkPath('file:///C:/Project/Play%20Instant.command'),
    'C:/Project/Play Instant.command',
  );
  for (const invalid of [
    'javascript:alert(1)',
    'data:text/html,example',
    'https://example.com/file.txt',
    '%ZZ',
  ])
    assert.equal(fileLinkPath(invalid), undefined);
  const opened: string[] = [];
  await openConversationFile(
    cwd,
    fileLinkPath(encodeURIComponent(name)),
    async value => {
      opened.push(value);
      return '';
    },
  );
  assert.deepEqual(opened, [path]);
  await assert.rejects(
    openConversationFile(cwd, 'missing.txt', async () => {
      assert.fail('Missing files must not be opened');
    }),
    {code: 'ENOENT'},
  );
  await assert.rejects(
    openConversationFile(cwd, decoded, async () => 'Could not open file.'),
    /Could not open file/,
  );
});

void test('screenshot filenames in inline code become project links', () => {
  assert.deepEqual(
    fileLinkParts(
      '**`src/ai-worker.js`** contains the chess AI logic.\n\n`src/main.js` starts the AI worker.',
    ),
    [
      {text: '**'},
      {text: 'src/ai-worker.js', path: 'src/ai-worker.js'},
      {text: '** contains the chess AI logic.\n\n'},
      {text: 'src/main.js', path: 'src/main.js'},
      {text: ' starts the AI worker.'},
    ],
  );
  assert.deepEqual(
    fileLinkParts('`README.md` and `.env` and `src/100% #1.js`'),
    [
      {text: 'README.md', path: 'README.md'},
      {text: ' and '},
      {text: '.env', path: '.env'},
      {text: ' and '},
      {text: 'src/100% #1.js', path: 'src/100% #1.js'},
    ],
  );
  for (const text of [
    '`node src/main.js`',
    '`console.log(1)`',
    '`hello world`',
    '`1.3`',
    '`./run.sh --help`',
    '`javascript:alert(1)`',
    '```js\nconst name = "src/main.js";\n```',
  ])
    assert.deepEqual(fileLinkParts(text), [{text}]);
});

void test('Windows drive and UNC targets keep their roots when resolved in a project', () => {
  const cwd = 'D:\\code\\chess';
  const cases = [
    ['C:\\code\\chess\\src\\main.js', 'C:\\code\\chess\\src\\main.js'],
    ['C:/code/chess/src/main.js', 'C:\\code\\chess\\src\\main.js'],
    ['/C:/code/chess/src/main.js', 'C:\\code\\chess\\src\\main.js'],
    ['file:///C:/code/chess/src/main.js', 'C:\\code\\chess\\src\\main.js'],
    [
      'file://localhost/C:/code/chess/src/main.js',
      'C:\\code\\chess\\src\\main.js',
    ],
    [
      'file://server/share/project/main.js',
      '\\\\server\\share\\project\\main.js',
    ],
    [
      '\\\\server\\share\\project\\main.js',
      '\\\\server\\share\\project\\main.js',
    ],
    ['src/main.js', 'D:\\code\\chess\\src\\main.js'],
    ['.\\src\\main.js', 'D:\\code\\chess\\src\\main.js'],
    ['../shared/main.js', 'D:\\code\\shared\\main.js'],
  ];
  for (const [target, expected] of cases) {
    const parsed = fileLinkPath(target);
    assert.ok(parsed, target);
    assert.equal(win32.resolve(cwd, parsed), expected, target);
    assert.deepEqual(fileLinkParts(`[source](${target})`), [
      {text: 'source', path: parsed},
    ]);
  }
  assert.deepEqual(fileLinkParts('`C:\\Project Files\\100% #1.js`'), [
    {
      text: 'C:\\Project Files\\100% #1.js',
      path: 'C:\\Project Files\\100% #1.js',
    },
  ]);
  assert.deepEqual(fileLinkParts('file:///C:/code/100%2520.js'), [
    {text: '100%20.js', path: 'C:/code/100%20.js'},
  ]);
});

void test('file URLs and angle-delimited web URLs preserve filename punctuation', () => {
  for (const suffix of ['!', ',', ';', ')', '.']) {
    const target = `file:///C:/work/release${suffix}`;
    const part = {text: `release${suffix}`, path: `C:/work/release${suffix}`};
    assert.deepEqual(fileLinkParts(target), [part]);
    assert.deepEqual(fileLinkParts(`<${target}>`), [
      {text: '<'},
      part,
      {text: '>'},
    ]);
  }
  assert.deepEqual(fileLinkParts('<https://example.com/release!>'), [
    {text: '<'},
    {text: 'https://example.com/release!', url: 'https://example.com/release!'},
    {text: '>'},
  ]);
});

void test('Windows and POSIX home links open files in the home directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-home-links-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const home = join(directory, 'home');
  await mkdir(join(home, 'Documents'), {recursive: true});
  const path = join(home, 'Documents', 'script.js');
  await writeFile(path, 'example');
  const previous = {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const opened: string[] = [];
  for (const reference of [
    '~/Documents/script.js',
    '~\\Documents\\script.js',
  ]) {
    assert.deepEqual(fileLinkParts('`' + reference + '`'), [
      {text: reference, path: reference},
    ]);
    await openConversationFile(
      directory,
      fileLinkPath(reference),
      async value => {
        opened.push(value);
        return '';
      },
    );
  }
  assert.deepEqual(opened, [path, path]);
  await writeFile(join(home, 'Documents', 'plan.md'), '# Home plan');
  for (const reference of ['~/Documents/plan.md', '~\\Documents\\plan.md']) {
    assert.deepEqual(fileLinkParts('`' + reference + '`'), [
      {text: reference, path: reference},
    ]);
    const markdown = await readMarkdownFile(directory, fileLinkPath(reference));
    assert.equal(markdown.content, '# Home plan');
  }
});

void test('Markdown file and web targets support parentheses and angle brackets', () => {
  assert.deepEqual(
    fileLinkParts(
      '[copy](C:/Project/src/main(copy).js) [angle](<C:/Project Files/a (copy).js>) [web](https://example.com/guide_(Windows))',
    ),
    [
      {text: 'copy', path: 'C:/Project/src/main(copy).js'},
      {text: ' '},
      {text: 'angle', path: 'C:/Project Files/a (copy).js'},
      {text: ' '},
      {text: 'web', url: 'https://example.com/guide_(Windows)'},
    ],
  );
});

void test('conversation web URLs preserve queries and trim surrounding prose punctuation', () => {
  assert.deepEqual(
    fileLinkParts(
      'See https://example.com/search?q=chess#ai, (https://example.com/guide_(Windows)). `http://localhost:3000/`',
    ),
    [
      {text: 'See '},
      {
        text: 'https://example.com/search?q=chess#ai',
        url: 'https://example.com/search?q=chess#ai',
      },
      {text: ', ('},
      {
        text: 'https://example.com/guide_(Windows)',
        url: 'https://example.com/guide_(Windows)',
      },
      {text: '). '},
      {text: 'http://localhost:3000/', url: 'http://localhost:3000/'},
    ],
  );
  for (const target of [
    'javascript:alert(1)',
    'data:text/html,example',
    'file:///C:/test.txt',
    'ms-settings:privacy',
    '//example.com',
    'https://',
    'https://example.com/\nnext',
    'https://exa\nmple.com',
    'https://example.com/a b',
  ])
    assert.equal(externalLinkURL(target), undefined, target);
});

void test('desktop URL opener validates the scheme and forwards browser failures', async () => {
  const opened: string[] = [];
  const open = async (url: string) => {
    opened.push(url);
  };
  await openConversationURL('https://example.com/chess?q=1#ai', open);
  assert.deepEqual(opened, ['https://example.com/chess?q=1#ai']);
  for (const target of [
    undefined,
    null,
    42,
    '',
    'javascript:alert(1)',
    'file:///C:/test.txt',
    'ms-settings:privacy',
    'C:\\code\\main.js',
    'https://',
    'https://exa\nmple.com',
    'https://example.com/a b',
  ])
    await assert.rejects(
      openConversationURL(target, open),
      /valid HTTP or HTTPS link/,
    );
  assert.equal(opened.length, 1);
  await assert.rejects(
    openConversationURL('https://example.com', async () => {
      throw new Error('Browser unavailable');
    }),
    /Browser unavailable/,
  );
});

void test('desktop preload sends file and URL links through their respective IPC routes', async () => {
  const calls: Array<{channel: string; args: unknown[]}> = [];
  let api:
    | {
        openFile: (id: string, path: string) => Promise<unknown>;
        openExternal: (url: string) => Promise<unknown>;
      }
    | undefined;
  let error = '';
  vm.runInNewContext(
    await readFile(
      new URL('../assets/desktop/preload.cjs', import.meta.url),
      'utf8',
    ),
    {
      require: () => ({
        contextBridge: {
          exposeInMainWorld(_name: string, value: typeof api) {
            api = value;
          },
        },
        ipcRenderer: {
          invoke: async (channel: string, ...args: unknown[]) => {
            calls.push({channel, args});
            return error ? {ok: false, error} : {ok: true};
          },
        },
        webFrame: {},
      }),
    },
  );
  await api!.openFile('windows', 'C:\\code\\chess\\src\\main.js');
  await api!.openExternal('https://example.com/chess');
  assert.deepEqual(calls, [
    {
      channel: 'pidev:open-file',
      args: ['windows', 'C:\\code\\chess\\src\\main.js'],
    },
    {channel: 'pidev:open-external', args: ['https://example.com/chess']},
  ]);
  error = 'Browser unavailable';
  await assert.rejects(
    api!.openExternal('https://example.com'),
    /Browser unavailable/,
  );
});
