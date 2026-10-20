import assert from 'node:assert/strict';
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isWSL, openBrowser} from '../src/runtime/browser.mjs';
import {patchBrowser, patchBundledBrowser} from '../scripts/patch-browser.mjs';

const url =
  'https://claude.ai/oauth/authorize?code=true&state=a%2Bb&scope=x+y#fragment';
const wsl = {
  platform: 'linux',
  env: {WSL_DISTRO_NAME: 'Ubuntu'},
  kernel: 'test',
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-browser-'));
  t.after(async () => {
    try {
      process.kill(
        -Number(await readFile(join(directory, 'pid'), 'utf8')),
        'SIGKILL',
      );
    } catch {
      // The fake launcher may already have exited or may never have started.
    }
    await rm(directory, {recursive: true, force: true});
  });
  return directory;
}

void test('WSL detection requires Linux and accepts interop, distro, or kernel evidence', () => {
  assert.equal(isWSL(wsl), true);
  assert.equal(isWSL({...wsl, env: {WSL_INTEROP: '/run/WSL/1_interop'}}), true);
  assert.equal(
    isWSL({...wsl, env: {}, kernel: '5.15.153.1-microsoft-standard-WSL2'}),
    true,
  );
  assert.equal(isWSL({...wsl, env: {}, kernel: '6.8.0-generic'}), false);
  assert.equal(isWSL({...wsl, platform: 'darwin'}), false);
  assert.equal(isWSL({...wsl, platform: 'win32'}), false);
});

void test('WSL launch preserves the complete OAuth URL as one argv argument', async () => {
  const calls: Array<[string, string[]]> = [];
  await openBrowser(url, {
    ...wsl,
    run: async (command: string, args: string[]) => {
      calls.push([command, args]);
    },
    fallback: async () => assert.fail('Windows launch succeeded'),
  });
  assert.deepEqual(calls, [
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
  ]);
});

void test('WSL launcher errors advance through Windows and wslview before the host fallback', async () => {
  const commands: string[] = [];
  const opened: string[] = [];
  await openBrowser(url, {
    ...wsl,
    run: async (command: string, args: string[]) => {
      commands.push(command);
      assert.equal(args.at(-1), url);
      throw new Error('Interop unavailable');
    },
    fallback: async (target: string) => {
      opened.push(target);
    },
  });
  assert.deepEqual(commands, [
    'rundll32.exe',
    '/mnt/c/Windows/System32/rundll32.exe',
    'wslview',
  ]);
  assert.deepEqual(opened, [url]);
  for (const successful of [1, 2]) {
    let attempt = 0;
    await openBrowser(url, {
      ...wsl,
      run: async () => {
        if (attempt++ < successful) throw new Error('Missing');
      },
      fallback: async () => assert.fail('Alternative WSL launcher succeeded'),
    });
    assert.equal(attempt, successful + 1);
  }
});

void test('ordinary hosts keep their opener and reject non-HTTP auth links before launch', async () => {
  for (const [platform, command, args] of [
    ['darwin', 'open', [url]],
    ['win32', 'rundll32', ['url.dll,FileProtocolHandler', url]],
    ['linux', 'xdg-open', [url]],
  ] as const) {
    const calls: unknown[] = [];
    await openBrowser(url, {
      platform,
      env: {},
      kernel: 'generic',
      run: async (...argv: unknown[]) => {
        calls.push(argv);
      },
    });
    assert.deepEqual(calls, [[command, args]]);
  }
  for (const target of [
    'file:///tmp/example',
    'javascript:alert(1)',
    'not a URL',
  ])
    await assert.rejects(
      openBrowser(target, {
        ...wsl,
        run: async () => assert.fail('Invalid protocol launched'),
      }),
    );
  await assert.rejects(
    openBrowser(url, {
      ...wsl,
      run: async () => {
        throw new Error('No launcher');
      },
    }),
    /No launcher/,
  );
});

void test('native Pi browser adapter retains generic file opening and is idempotent', async t => {
  const sourcePath = new URL(
    './utils/open-browser.js',
    import.meta.resolve('@earendil-works/pi-coding-agent'),
  );
  const source = await readFile(sourcePath, 'utf8');
  const patched = patchBrowser(source);
  assert.equal(patchBrowser(patched), patched);
  assert.throws(
    () => patchBrowser('export function renamed() {}'),
    /review the WSL adapter/,
  );
  // Execute the adapter with its host dependencies recorded, without opening a browser.
  const directory = await fixture(t);
  await writeFile(
    join(directory, 'varisdev-browser.mjs'),
    'export const isWSL = () => true; export async function openBrowser(url) { globalThis.wslOpened.push(url); }',
  );
  const executable = patched.replace(
    'import { spawn } from "node:child_process";',
    'const spawn = (...args) => { globalThis.nativeOpened.push(args); return {on() {return this}, unref() {}}; };',
  );
  await writeFile(join(directory, 'open-browser.mjs'), executable);
  const globals = globalThis as typeof globalThis & {
    wslOpened: string[];
    nativeOpened: unknown[][];
  };
  globals.wslOpened = [];
  globals.nativeOpened = [];
  t.after(() => {
    Reflect.deleteProperty(globals, 'wslOpened');
    Reflect.deleteProperty(globals, 'nativeOpened');
  });
  const native = await import(
    pathToFileURL(join(directory, 'open-browser.mjs')).href
  );
  native.openBrowser(url);
  native.openBrowser('/tmp/Pi export.html');
  assert.deepEqual(globals.wslOpened, [url]);
  assert.equal(globals.nativeOpened.length, 1);
  assert.equal(
    (globals.nativeOpened[0][1] as string[]).at(-1),
    '/tmp/Pi export.html',
  );
});

void test(
  'installed native login dialog reaches the WSL browser adapter and a local callback',
  {timeout: 8000, skip: process.platform === 'win32'},
  async t => {
    const directory = await fixture(t);
    const utils = join(
      directory,
      'node_modules/@earendil-works/pi-coding-agent/dist/utils',
    );
    await mkdir(utils, {recursive: true});
    const pi = dirname(
      fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')),
    );
    await writeFile(
      join(utils, 'open-browser.js'),
      await readFile(join(pi, 'utils/open-browser.js')),
    );
    await patchBundledBrowser(directory);
    // Keep failed fake launches inside the fixture, including on a real WSL host.
    const helperPath = join(utils, 'varisdev-browser.mjs');
    await writeFile(
      helperPath,
      (await readFile(helperPath, 'utf8')).replace(
        '/mnt/c/Windows/System32/rundll32.exe',
        join(directory, 'missing-mounted-browser'),
      ),
    );
    const launcher = join(directory, 'rundll32.exe');
    const argsPath = join(directory, 'args.json');
    const pidPath = join(directory, 'pid');
    await writeFile(
      launcher,
      `#!${process.execPath}\nsetTimeout(() => process.exit(2), 2000).unref(); import('node:fs').then(fs => { fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); fs.writeFileSync(${JSON.stringify(argsPath)}, JSON.stringify(process.argv.slice(2))); return fetch(process.argv[3]); }).then(r => {if (!r.ok) process.exitCode=1}).catch(() => process.exitCode=1);`,
    );
    await chmod(launcher, 0o755);
    const priorPath = process.env.PATH;
    const priorDistro = process.env.WSL_DISTRO_NAME;
    const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    process.env.PATH = directory;
    process.env.WSL_DISTRO_NAME = 'Ubuntu';
    Object.defineProperty(process, 'platform', {...descriptor, value: 'linux'});
    t.after(() => {
      Object.defineProperty(process, 'platform', descriptor);
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
      if (priorDistro === undefined) delete process.env.WSL_DISTRO_NAME;
      else process.env.WSL_DISTRO_NAME = priorDistro;
    });
    let complete!: () => void;
    const callback = new Promise<void>(resolve => {
      complete = resolve;
    });
    const server = createServer((request, response) => {
      response.end('ok');
      complete();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const target = `http://127.0.0.1:${address.port}/callback?code=test&state=a%2Bb#fragment`;
    const loginPath = join(pi, 'modes/interactive/components/login-dialog.js');
    const loginSource = (await readFile(loginPath, 'utf8')).replace(
      /from "([^"]+)"/g,
      (_match, specifier: string) => {
        const resolved = specifier.includes('utils/open-browser.js')
          ? pathToFileURL(join(utils, 'open-browser.js')).href
          : specifier.startsWith('.')
            ? pathToFileURL(join(dirname(loginPath), specifier)).href
            : import.meta.resolve(specifier);
        return `from ${JSON.stringify(resolved)}`;
      },
    );
    await writeFile(join(directory, 'login-dialog.mjs'), loginSource);
    const {initTheme} = await import(
      pathToFileURL(join(pi, 'modes/interactive/theme/theme.js')).href
    );
    initTheme('dark');
    const {LoginDialogComponent} = await import(
      pathToFileURL(join(directory, 'login-dialog.mjs')).href
    );
    const dialog = new LoginDialogComponent(
      {requestRender() {}},
      'anthropic',
      () => {},
    );
    dialog.showAuth(target, 'Continue in your browser.');
    await callback;
    assert.deepEqual(JSON.parse(await readFile(argsPath, 'utf8')), [
      'url.dll,FileProtocolHandler',
      target,
    ]);
  },
);

void test(
  'a stalled launcher and its child are terminated on timeout',
  {timeout: 5000, skip: process.platform === 'win32'},
  async t => {
    const directory = await fixture(t);
    const launcher = join(directory, 'rundll32.exe');
    const heartbeat = join(directory, 'heartbeat');
    const pidPath = join(directory, 'pid');
    await writeFile(
      launcher,
      `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setInterval(() => require('node:fs').writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 10); setTimeout(() => process.exit(0), 3000);`)}], {stdio:'ignore'}); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 3000);`,
    );
    await chmod(launcher, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = directory;
    t.after(() => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
    });
    const helper = join(directory, 'bounded-browser.mjs');
    await writeFile(
      helper,
      (
        await readFile(
          new URL('../src/runtime/browser.mjs', import.meta.url),
          'utf8',
        )
      ).replace(
        '/mnt/c/Windows/System32/rundll32.exe',
        join(directory, 'missing-mounted-browser'),
      ),
    );
    const {openBrowser: boundedOpenBrowser} = await import(
      pathToFileURL(helper).href
    );
    let fellBack = false;
    await boundedOpenBrowser(url, {
      ...wsl,
      timeoutMs: 500,
      fallback: async () => {
        fellBack = true;
      },
    });
    assert.equal(fellBack, true);
    const stopped = await readFile(heartbeat, 'utf8');
    await delay(100);
    assert.equal(await readFile(heartbeat, 'utf8'), stopped);
  },
);

void test(
  'ordinary Linux browser launches return after spawn and keep running',
  {timeout: 4000, skip: process.platform === 'win32'},
  async t => {
    const directory = await fixture(t);
    const launcher = join(directory, 'xdg-open');
    const heartbeat = join(directory, 'heartbeat');
    const pidPath = join(directory, 'pid');
    await writeFile(
      launcher,
      `#!${process.execPath}\nconst fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => fs.writeFileSync(${JSON.stringify(heartbeat)}, String(Date.now())), 10); setTimeout(() => process.exit(0), 1500);`,
    );
    await chmod(launcher, 0o755);
    const previous = process.env.PATH;
    process.env.PATH = directory;
    t.after(async () => {
      if (previous === undefined) delete process.env.PATH;
      else process.env.PATH = previous;
      try {
        process.kill(-Number(await readFile(pidPath, 'utf8')), 'SIGKILL');
      } catch {
        // The fake opener may have finished before cleanup.
      }
    });
    await openBrowser(url, {
      platform: 'linux',
      env: {},
      kernel: 'generic',
      timeoutMs: 20,
    });
    let first = '';
    for (let attempt = 0; attempt < 100 && !first; attempt++) {
      first = await readFile(heartbeat, 'utf8').catch(() => '');
      if (!first) await delay(10);
    }
    assert.ok(first, 'Browser did not start');
    await delay(100);
    assert.notEqual(await readFile(heartbeat, 'utf8'), first);
  },
);
