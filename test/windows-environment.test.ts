import assert from 'node:assert/strict';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, win32} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {
  copyEnvironment,
  createEnvironmentSettings,
  environmentPath,
  readShellEnvironment,
  resolveUserShell,
  shellEnvironment,
  windowsEnvironment,
  withNodePath,
} from '../src/runtime/environment.mjs';
import {runTerminalProcess} from './fixtures/terminal-process.mjs';
import {runCommand} from '../scripts/test-installer.mjs';

const inheritedPath = 'C:\\Runtime;C:\\Windows\\System32';
const registeredPaths = [
  'c:\\windows\\system32\\;C:\\Program Files\\Git\\cmd',
  'C:\\Users\\test\\Työkalut;;C:/Program Files/Git/cmd',
];
const fallbackPath = [
  inheritedPath,
  'C:\\Program Files\\Git\\cmd',
  'C:\\Users\\test\\Työkalut',
].join(';');

void test('npm lifecycle environments prepend the selected Node directory and normalize Windows Path casing', () => {
  for (const name of ['PATH', 'Path', 'path']) {
    const env = {[name]: inheritedPath, CUSTOM_TOOL: 'keep'};
    const child = withNodePath('D:\\Node runtime\\node.exe', env, 'win32');
    assert.deepEqual(child, {
      PATH: `D:\\Node runtime;${inheritedPath}`,
      CUSTOM_TOOL: 'keep',
    });
    assert.equal(env[name], inheritedPath);
  }
  for (const env of [{}, {Path: ''}]) {
    assert.deepEqual(withNodePath('D:\\Node runtime\\node.exe', env, 'win32'), {
      PATH: 'D:\\Node runtime',
    });
  }
});

void test('Windows PATH recovery preserves inherited tools and adds system and user tools once', () => {
  for (const name of ['PATH', 'Path', 'path']) {
    const env = {[name]: inheritedPath, CUSTOM_TOOL: 'inherited', HOME: 'home'};
    const recovered = windowsEnvironment(env, registeredPaths);
    assert.equal(recovered.PATH, fallbackPath);
    assert.equal(recovered.CUSTOM_TOOL, 'inherited');
    assert.deepEqual(
      Object.keys(recovered).filter(key => key.toLowerCase() === 'path'),
      ['PATH'],
    );
    assert.equal(
      env[name],
      inheritedPath,
      'Reading fallback does not mutate its input',
    );
    assert.equal(copyEnvironment(env, 'win32').PATH, inheritedPath);
    assert.equal(copyEnvironment(env, 'win32').HOME, 'home');
  }
  assert.equal(
    windowsEnvironment({}, [null, 'C:\\User tools']).PATH,
    'C:\\User tools',
  );
  assert.equal(
    windowsEnvironment({Path: '\\;C:;C:\\'}, ['c:\\;C:\\Tools\\;c:/tools'])
      .PATH,
    '\\;C:;C:\\;C:\\Tools\\',
    'Root paths and drive-relative paths remain distinct',
  );
});

void test(
  'Windows saved PATH aliases override recovery and removal restores the fallback without persisting it',
  {timeout: 5000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-windows-env-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    for (const name of ['PATH', 'Path', 'path']) {
      const file = join(directory, name + '.json');
      const env: NodeJS.ProcessEnv = {
        Path: inheritedPath,
        CUSTOM_TOOL: 'inherited',
      };
      const text =
        JSON.stringify({[name]: 'D:\\Chosen tools', Unrelated: 'keep'}) + '\n';
      await writeFile(file, text);
      let reads = 0;
      const readEnvironment = async ({
        env: source = {},
      }: {
        env?: NodeJS.ProcessEnv;
      } = {}) => {
        reads++;
        return windowsEnvironment(source, registeredPaths);
      };
      const settings = createEnvironmentSettings({
        env,
        file,
        platform: 'win32',
        readEnvironment,
      });
      const initial = await settings.initialize();
      assert.equal(env.PATH, 'D:\\Chosen tools');
      assert.equal(initial.values.PATH, 'D:\\Chosen tools');
      assert.deepEqual(initial.savedNames, ['PATH', 'UNRELATED']);
      assert.deepEqual(
        Object.keys(env).filter(key => key.toLowerCase() === 'path'),
        ['PATH'],
      );
      await settings.get();
      assert.equal(
        await readFile(file, 'utf8'),
        text,
        'Viewing settings preserves the saved file',
      );
      assert.equal(
        reads,
        1,
        'Registry recovery runs once per settings instance',
      );
      const child = settings.forChild(undefined, {reuseShell: true});
      assert.equal(
        child.PATH,
        fallbackPath,
        'App continuations receive the real fallback',
      );
      assert.equal(child.UNRELATED, undefined);
      const continued = createEnvironmentSettings({
        env: child,
        file,
        platform: 'win32',
        readEnvironment,
      });
      await continued.initialize();
      assert.equal(reads, 1, 'App continuation reuses the recovered fallback');
      assert.equal(child.__VARISDEV_ENVIRONMENT_CONTINUATION, undefined);
      assert.equal(child.PATH, 'D:\\Chosen tools');
      const removed = await continued.save('pAtH', null);
      assert.equal(removed.values.PATH, fallbackPath);
      assert.equal(child.PATH, fallbackPath);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        Unrelated: 'keep',
      });
      await settings.get();
      assert.equal(env.PATH, fallbackPath);
      env.PATH = 'C:\\App prefix;' + env.PATH;
      await settings.get();
      assert.equal(
        env.PATH,
        'C:\\App prefix;' + fallbackPath,
        'Viewing settings preserves runtime prefixes',
      );
      await settings.save('Path', 'E:\\Replacement');
      assert.equal(env.PATH, 'E:\\Replacement');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        Unrelated: 'keep',
        PATH: 'E:\\Replacement',
      });
      await settings.save('path', '');
      assert.equal(
        env.PATH,
        '',
        'An explicitly empty PATH also takes precedence',
      );
      await settings.save('PATH', null);
      assert.equal(env.PATH, fallbackPath);
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        Unrelated: 'keep',
      });
    }
  },
);

void test(
  'Windows registry failure retains inherited tools and saved settings',
  {timeout: 5000},
  async t => {
    const directory = await mkdtemp(
      join(tmpdir(), 'varisdev-windows-env-failure-'),
    );
    t.after(() => rm(directory, {recursive: true, force: true}));
    const file = join(directory, 'environment.json');
    const env: NodeJS.ProcessEnv = {
      Path: inheritedPath,
      CUSTOM_TOOL: 'inherited',
    };
    const settings = createEnvironmentSettings({
      env,
      file,
      platform: 'win32',
      readEnvironment: async () => {
        throw new Error('Could not read Windows PATH.');
      },
    });
    const initial = await settings.initialize();
    assert.match(initial.error || '', /Could not read Windows PATH/);
    assert.equal(env.PATH, inheritedPath);
    await assert.rejects(readFile(file), {code: 'ENOENT'});
    await settings.save('Path', 'D:\\Chosen tools');
    assert.equal(env.PATH, 'D:\\Chosen tools');
    await settings.save('PATH', null);
    assert.equal(env.PATH, inheritedPath);
    assert.equal(settings.forChild({Path: inheritedPath}).PATH, inheritedPath);
    await assert.rejects(readFile(file), {code: 'ENOENT'});
  },
);

void test(
  'Windows CLI launches preserve mixed-case PATH and distinguish fallback from saved overrides',
  {skip: process.platform !== 'win32', timeout: 30000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-cli-path-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const report = join(directory, 'child.json');
    const tools = join(directory, 'inherited tools');
    const chosen = join(directory, 'chosen tools');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: directory,
      LOCALAPPDATA: join(directory, 'local'),
    };
    for (const name of Object.keys(env))
      if (name.toLowerCase() === 'path') delete env[name];
    env.Path = tools;
    const settingsFile = environmentPath(env, 'win32');
    await mkdir(join(directory, 'local', 'VarisDev'), {recursive: true});
    const saved = JSON.stringify({Path: chosen});
    await writeFile(settingsFile, saved);
    await writeFile(join(directory, 'package.json'), '{"type":"module"}');
    const childSource = `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(report)}, JSON.stringify({path: process.env.PATH, names: Object.keys(process.env).filter(name => name.toLowerCase() === 'path'), continuation: process.env.__VARISDEV_ENVIRONMENT_CONTINUATION}));`;
    for (const relative of [
      'scripts',
      'desktop/node_modules/@earendil-works/pi-coding-agent/dist/bundle',
    ])
      await mkdir(join(directory, relative), {recursive: true});
    await writeFile(join(directory, 'scripts/desktop-app.mjs'), childSource);
    await writeFile(
      join(
        directory,
        'desktop/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      ),
      childSource,
    );
    for (const [args, continuation] of [
      [['app', 'install'], true],
      [['mcp', 'list'], false],
    ] as const) {
      const source = `
      const {RuntimeManager} = await import(${JSON.stringify(new URL('../src/runtime/manager.ts', import.meta.url).href)});
      RuntimeManager.prototype.currentRoot = async () => ${JSON.stringify(directory)};
      const {runCli} = await import(${JSON.stringify(new URL('../src/runtime/cli.ts', import.meta.url).href)});
      process.exitCode = await runCli(${JSON.stringify(args)}, ${JSON.stringify(directory)});
    `;
      await runTerminalProcess(
        process.execPath,
        ['--input-type=module', '-e', source],
        {env, cwd: directory, timeoutMs: 10000},
      );
      const child = JSON.parse(await readFile(report, 'utf8')) as {
        path: string;
        names: string[];
        continuation?: string;
      };
      assert.deepEqual(child.names, ['PATH']);
      assert.equal(child.continuation, continuation ? '1' : undefined);
      assert.equal(child.path.split(';').includes(tools), continuation);
      assert.equal(child.path.split(';').includes(chosen), !continuation);
      assert.equal(await readFile(settingsFile, 'utf8'), saved);
    }
  },
);

void test(
  'Unix environment copies retain case distinctions and shell unsets',
  {timeout: 5000},
  async t => {
    const directory = await mkdtemp(join(tmpdir(), 'varisdev-unix-env-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const env: NodeJS.ProcessEnv = {
      PATH: '/bin',
      Path: 'custom',
      CUSTOM_TOOL: 'removed',
    };
    assert.deepEqual(copyEnvironment(env, 'linux'), env);
    const settings = createEnvironmentSettings({
      env,
      file: join(directory, 'environment.json'),
      platform: 'linux',
      readEnvironment: async () => ({PATH: '/usr/bin', Path: 'custom'}),
    });
    await settings.initialize();
    assert.equal(env.CUSTOM_TOOL, undefined);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.Path, 'custom');
    await settings.save('Path', 'saved');
    assert.equal(env.Path, 'saved');
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(settings.forChild().Path, 'custom');
  },
);

void test('shell selection prefers PowerShell 7 on PATH and recovers normal installations with a restricted desktop PATH', () => {
  const pathShell = 'D:\\User tools\\pwsh.exe';
  const systemShell = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
  const userShell =
    'C:\\Users\\test\\AppData\\Local\\Microsoft\\PowerShell\\7\\pwsh.exe';
  const fallback =
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  for (const [env, installed, expected] of [
    [
      {Path: '"D:\\User tools";C:\\Windows\\System32'},
      [pathShell, systemShell],
      pathShell,
    ],
    [{PATH: 'C:\\Windows\\System32'}, [systemShell], systemShell],
    [
      {Path: '', LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local'},
      [userShell],
      userShell,
    ],
    [{SystemRoot: 'D:\\Windows', SHELL: '/bin/bash'}, [], fallback],
    [
      {ProgramW6432: 'D:\\Applications'},
      ['D:\\Applications\\PowerShell\\7\\pwsh.exe'],
      'D:\\Applications\\PowerShell\\7\\pwsh.exe',
    ],
  ] as const) {
    const result = resolveUserShell({
      env,
      platform: 'win32',
      exists: path => (installed as readonly string[]).includes(path),
    });
    assert.equal(result.file, expected);
    assert.deepEqual(result.args, ['-NoLogo']);
    assert.equal(result.kind, expected === fallback ? 'powershell' : 'pwsh');
  }
  assert.equal(
    resolveUserShell({
      env: {},
      platform: 'win32',
      shell: systemShell,
      exists: () => false,
    }).file,
    systemShell,
  );
  for (const [file, args] of [
    ['C:\\Windows\\System32\\cmd.exe', []],
    ['C:\\Program Files\\Git\\bin\\bash.exe', ['--login', '-i']],
    ['C:\\Tools\\nu.exe', ['-l']],
  ] as const) {
    assert.deepEqual(
      resolveUserShell({platform: 'win32', env: {}, shell: file}).args,
      args,
    );
  }
});

void test('Unix shell selection shares configured shell, account shell and platform fallbacks', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    assert.deepEqual(
      resolveUserShell({
        platform,
        env: {SHELL: '/custom/bin/nu'},
        userShell: () => '/bin/bash',
      }),
      {file: '/custom/bin/nu', args: ['-l'], kind: 'nu'},
    );
    assert.equal(
      resolveUserShell({
        platform,
        env: {},
        userShell: () => '/bin/bash',
      }).file,
      '/bin/bash',
    );
    assert.equal(
      resolveUserShell({
        platform,
        env: {},
        userShell: () => undefined,
      }).file,
      platform === 'darwin' ? '/bin/zsh' : '/bin/sh',
    );
    assert.equal(
      resolveUserShell({
        platform,
        env: {SHELL: '/bin/zsh'},
        shell: '/bin/bash',
      }).kind,
      'bash',
    );
  }
});

void test('shell environments retain user PowerShell 7 modules and clear incompatible module paths for Windows PowerShell', () => {
  const env = {
    Path: 'C:\\Tools',
    PSModulePath: 'C:\\User Modules',
    PRIVATE_TOKEN: 'keep',
  };
  assert.deepEqual(shellEnvironment(env, 'pwsh', 'win32'), {
    PATH: 'C:\\Tools',
    PSMODULEPATH: 'C:\\User Modules',
    PRIVATE_TOKEN: 'keep',
  });
  assert.deepEqual(shellEnvironment(env, 'powershell', 'win32'), {
    PATH: 'C:\\Tools',
    PRIVATE_TOKEN: 'keep',
  });
  assert.deepEqual(shellEnvironment(env, 'bash', 'linux'), env);
  assert.equal(env.PSModulePath, 'C:\\User Modules');
});

const nativeShells =
  process.platform === 'win32'
    ? [
        ...new Set([
          resolveUserShell().file,
          win32.join(
            process.env.SystemRoot || 'C:\\Windows',
            'System32',
            'WindowsPowerShell',
            'v1.0',
            'powershell.exe',
          ),
        ]),
      ]
    : [];
for (const shell of nativeShells) {
  void test(
    `Windows startup with ${win32.basename(shell)} merges registered values, launch exports and isolated profiles before saved settings`,
    {timeout: 30000},
    async t => {
      const base = new URL('../.varisdev/test-environment/', import.meta.url);
      await mkdir(base, {recursive: true});
      const directory = await mkdtemp(fileURLToPath(new URL('windows-', base)));
      t.after(() => rm(directory, {recursive: true, force: true}));
      const env: NodeJS.ProcessEnv = {
        SystemRoot: process.env.SystemRoot,
        HOME: directory,
        USERPROFILE: directory,
        LOCALAPPDATA: join(directory, 'local'),
        Path: 'C:\\Launch tools',
        LAUNCH_PLUGIN_TOKEN: 'launch-private',
        STALE_PLUGIN_TOKEN: 'remove-me',
        PSExecutionPolicyPreference: 'Bypass',
      };
      const profilePaths: string[] = [];
      const profileReads = join(directory, 'profile-reads');
      for (let index = 0; index < 4; index++) {
        const profile = join(directory, `profile-${index}.ps1`);
        profilePaths.push(profile);
        await writeFile(
          profile,
          '\ufeff' +
            `
          Write-Output 'private startup noise'
          [Console]::WriteLine('console-private-noise')
          $env:PROFILE_ORDER += '${index}'
          [IO.File]::AppendAllText('${profileReads.replace(/'/g, "''")}', '${index}')
          $env:OPENAI_API_KEY = $env:REGISTERED_PLUGIN_TOKEN + '-profile'
          $env:PROFILE_MULTILINE = "first=ä\`nsecond=値"
          $env:PATH = 'D:\\Profile tools;' + $env:PATH
          Remove-Item Env:STALE_PLUGIN_TOKEN -ErrorAction SilentlyContinue
        `,
        );
      }
      const file = join(directory, 'environment.json');
      const text =
        '{ "OPENAI_API_KEY": "saved-private", "Path": "E:\\\\Saved tools" }\n';
      await writeFile(file, text);
      const settings = createEnvironmentSettings({
        env,
        file,
        platform: 'win32',
        shell,
        timeoutMs: 5000,
        windows: {
          machineEnvironment: {
            REGISTERED_PLUGIN_TOKEN: 'machine-private',
            MACHINE_ONLY_SETTING: 'machine',
            LAUNCH_PLUGIN_TOKEN: 'machine-launch',
            Path: 'C:\\Machine tools',
          },
          userEnvironment: {
            REGISTERED_PLUGIN_TOKEN: 'user-private',
            USER_ONLY_SETTING: 'user',
            LAUNCH_PLUGIN_TOKEN: 'user-launch',
            Path: '%USER_TOOL_DIRECTORY%;C:\\Machine tools',
            USER_TOOL_DIRECTORY: 'C:\\User tools',
            EXPANDED_SETTING: '%MACHINE_ONLY_SETTING%/expanded',
          },
          profilePaths,
        },
      });
      const state = await settings.initialize();
      assert.equal(state.error, undefined);
      assert.equal(env.OPENAI_API_KEY, 'saved-private');
      assert.equal(env.REGISTERED_PLUGIN_TOKEN, 'user-private');
      assert.equal(env.MACHINE_ONLY_SETTING, 'machine');
      assert.equal(env.USER_ONLY_SETTING, 'user');
      assert.equal(env.EXPANDED_SETTING, 'machine/expanded');
      assert.equal(env.LAUNCH_PLUGIN_TOKEN, 'launch-private');
      assert.equal(env.STALE_PLUGIN_TOKEN, undefined);
      assert.equal(env.PROFILE_ORDER, '0123');
      assert.equal(env.PROFILE_MULTILINE, 'first=ä\nsecond=値');
      assert.equal(env.PATH, 'E:\\Saved tools');
      assert.equal(await readFile(file, 'utf8'), text);
      assert.deepEqual(state.savedNames, ['OPENAI_API_KEY', 'PATH']);
      const fallback = settings.forChild(undefined, {reuseShell: true});
      assert.equal(fallback.OPENAI_API_KEY, 'user-private-profile');
      const fallbackPaths: string[] | undefined = fallback.PATH?.split(';');
      assert.equal(fallbackPaths?.[0], 'D:\\Profile tools');
      assert.deepEqual(
        fallbackPaths?.filter(path => path !== win32.dirname(shell)),
        [
          'D:\\Profile tools',
          'C:\\Launch tools',
          'C:\\Machine tools',
          'C:\\User tools',
        ],
      );
      const recoveredPath = fallback.PATH;
      const continued = createEnvironmentSettings({
        env: fallback,
        file,
        platform: 'win32',
        shell,
        timeoutMs: 5000,
        windows: {profilePaths},
      });
      const continuedState = await continued.initialize();
      assert.equal(continuedState.error, undefined);
      assert.equal(fallback.OPENAI_API_KEY, 'saved-private');
      assert.equal(fallback.PATH, 'E:\\Saved tools');
      assert.equal(fallback.PROFILE_ORDER, '0123');
      assert.equal(fallback.__VARISDEV_ENVIRONMENT_CONTINUATION, undefined);
      assert.equal(await readFile(profileReads, 'utf8'), '0123');
      await continued.save('OPENAI_API_KEY', null);
      assert.equal(fallback.OPENAI_API_KEY, 'user-private-profile');
      await settings.get();
      assert.equal(env.OPENAI_API_KEY, 'user-private-profile');
      assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
        Path: 'E:\\Saved tools',
      });
      await settings.save('Path', null);
      assert.equal(env.PATH, recoveredPath);
      await settings.get();
      await assert.rejects(access(file), {code: 'ENOENT'});
    },
  );
}

for (const shell of nativeShells) {
  void test(
    `Windows update restart rereads edited ${win32.basename(shell)} profiles and restores refreshed fallbacks after removing saved overrides`,
    {timeout: 35000},
    async t => {
      const base = new URL('../.varisdev/test-environment/', import.meta.url);
      await mkdir(base, {recursive: true});
      const directory = await mkdtemp(
        fileURLToPath(new URL('windows-restart-', base)),
      );
      t.after(() => rm(directory, {recursive: true, force: true}));
      const profile = join(directory, 'profile.ps1');
      const profileReads = join(directory, 'profile-reads');
      const file = join(directory, 'environment.json');
      const beforeTools = join(directory, 'before tools');
      const afterTools = join(directory, 'after tools');
      const quote = (text: string) => "'" + text.replace(/'/g, "''") + "'";
      const profileText = (version: string, tools: string) =>
        '\ufeff' +
        `
        [IO.File]::AppendAllText(${quote(profileReads)}, '${version};')
        $env:RESTART_FALLBACK = '${version}-fallback'
        $env:OPENAI_API_KEY = '${version}-openai-key'
        $env:ANTHROPIC_API_KEY = '${version}-anthropic-key'
        $env:PATH = ${quote(tools)}
      `;
      await writeFile(profile, profileText('before', beforeTools));
      await writeFile(
        file,
        JSON.stringify({
          OPENAI_API_KEY: 'saved-before',
          SAVED_ONLY_SETTING: 'keep',
        }),
      );
      // Each app runs in its own process because updateRestartCommand uses the
      // process singleton. Keep shell and registry inputs isolated from the user.
      const startup = `
        import assert from 'node:assert/strict';
        import {readFile, writeFile} from 'node:fs/promises';
        import {createEnvironmentSettings, initializeEnvironment} from ${JSON.stringify(new URL('../src/runtime/environment.mjs', import.meta.url).href)};
        const inheritedMarker = process.env.__VARISDEV_ENVIRONMENT_CONTINUATION;
        const settings = createEnvironmentSettings(${JSON.stringify({
          file,
          platform: 'win32',
          shell,
          timeoutMs: 5000,
          windows: {
            machineEnvironment: {},
            userEnvironment: {},
            profilePaths: [profile],
          },
        })});
        globalThis[Symbol.for('varisdev.environment-settings.v4')] = settings;
        await initializeEnvironment();
        const state = await settings.get();
        assert.equal(state.error, undefined);
      `;
      const cli = join(directory, 'bin/varisdev.mjs');
      await mkdir(join(directory, 'bin'), {recursive: true});
      await writeFile(
        cli,
        startup +
          `
          assert.equal(process.env.RESTART_FALLBACK, 'after-fallback');
          assert.equal(process.env.ANTHROPIC_API_KEY, 'after-anthropic-key');
          assert.equal(process.env.PATH, ${JSON.stringify(afterTools)});
          assert.equal(process.env.OPENAI_API_KEY, 'saved-after');
          assert.equal(inheritedMarker, undefined);
          assert.equal(process.env.__VARISDEV_ENVIRONMENT_CONTINUATION, undefined);
          assert.deepEqual(state.savedNames, ['OPENAI_API_KEY', 'SAVED_ONLY_SETTING']);
          assert.equal(await readFile(${JSON.stringify(profileReads)}, 'utf8'), 'before;after;');
          assert.equal(settings.forChild().OPENAI_API_KEY, 'after-openai-key');
          await settings.save('OPENAI_API_KEY', null);
          assert.equal(process.env.OPENAI_API_KEY, 'after-openai-key');
          assert.deepEqual((await settings.get()).savedNames, ['SAVED_ONLY_SETTING']);
          assert.deepEqual(JSON.parse(await readFile(${JSON.stringify(file)}, 'utf8')), {SAVED_ONLY_SETTING: 'keep'});
        `,
      );
      const source =
        startup +
        `
        import {updateRestartCommand} from ${JSON.stringify(new URL('../src/desktop/updates.ts', import.meta.url).href)};
        import {runCommand} from ${JSON.stringify(new URL('../scripts/test-installer.mjs', import.meta.url).href)};
        assert.equal(process.env.RESTART_FALLBACK, 'before-fallback');
        assert.equal(process.env.OPENAI_API_KEY, 'saved-before');
        assert.equal(process.env.ANTHROPIC_API_KEY, 'before-anthropic-key');
        assert.equal(process.env.PATH, ${JSON.stringify(beforeTools)});
        assert.equal(await readFile(${JSON.stringify(profileReads)}, 'utf8'), 'before;');
        await writeFile(${JSON.stringify(profile)}, ${JSON.stringify(profileText('after', afterTools))});
        await writeFile(${JSON.stringify(file)}, JSON.stringify({OPENAI_API_KEY: 'saved-after', SAVED_ONLY_SETTING: 'keep'}));
        const command = updateRestartCommand(${JSON.stringify(directory)}, process.execPath, process.execPath);
        assert.equal(command.env.OPENAI_API_KEY, 'before-openai-key');
        assert.equal(process.env.OPENAI_API_KEY, 'saved-before');
        await runCommand(command.executable, command.args, {cwd: ${JSON.stringify(directory)}, env: command.env, timeoutMs: 15000});
        assert.equal(await readFile(${JSON.stringify(profileReads)}, 'utf8'), 'before;after;');
      `;
      await runCommand(
        process.execPath,
        ['--input-type=module', '-e', source],
        {
          cwd: directory,
          env: {
            SystemRoot: process.env.SystemRoot,
            HOME: directory,
            USERPROFILE: directory,
            LOCALAPPDATA: join(directory, 'local'),
            PATH: 'C:\\Launch tools',
            PSExecutionPolicyPreference: 'Bypass',
          },
          timeoutMs: 28000,
        },
      );
    },
  );
}

void test(
  'native Windows startup recovers registry fields beyond PATH without writing registry or user profiles',
  {skip: process.platform !== 'win32', timeout: 15000},
  async () => {
    const env = {
      SystemRoot: process.env.SystemRoot,
      Path: 'C:\\Launch tools',
      CUSTOM_LAUNCH: 'keep',
    };
    const values = await readShellEnvironment({
      env,
      timeoutMs: 5000,
      windows: {profilePaths: []},
    });
    assert.equal(values.CUSTOM_LAUNCH, 'keep');
    assert.equal(
      values.OS,
      'Windows_NT',
      'Registered machine values are available without inheriting them',
    );
    assert.ok(values.COMSPEC?.toLowerCase().endsWith('\\cmd.exe'));
    assert.ok(values.PATH.split(';').includes('C:\\Launch tools'));
    assert.ok(values.PATH.split(';').length > 1);
    assert.equal(env.Path, 'C:\\Launch tools');
  },
);

for (const shell of nativeShells) {
  void test(
    `Windows ${win32.basename(shell)} startup deadlines and cancellation stop profile descendants without exposing output`,
    {timeout: 30000},
    async t => {
      const base = new URL('../.varisdev/test-environment/', import.meta.url);
      await mkdir(base, {recursive: true});
      const directory = await mkdtemp(
        fileURLToPath(new URL('windows-timeout-', base)),
      );
      t.after(() => rm(directory, {recursive: true, force: true}));
      const quote = (text: string) => "'" + text.replace(/'/g, "''") + "'";
      for (const cancel of [false, true]) {
        const pidFile = join(directory, `child-${cancel}.pid`);
        const profile = join(directory, `profile-${cancel}.ps1`);
        await writeFile(
          profile,
          '\ufeff' +
            `
          [Console]::WriteLine('private-profile-output')
          $info = New-Object Diagnostics.ProcessStartInfo
          $info.FileName = ${quote(process.execPath)}
          $info.Arguments = '-e "setTimeout(() => {}, 30000)"'
          $info.UseShellExecute = $false
          $info.CreateNoWindow = $true
          $child = [Diagnostics.Process]::Start($info)
          [IO.File]::WriteAllText(${quote(pidFile)}, [string]$child.Id)
          Start-Sleep -Seconds 30
        `,
        );
        const controller = new AbortController();
        const pending = readShellEnvironment({
          env: {
            SystemRoot: process.env.SystemRoot,
            HOME: directory,
            USERPROFILE: directory,
            PSExecutionPolicyPreference: 'Bypass',
          },
          shell,
          timeoutMs: cancel ? 8000 : 3500,
          signal: controller.signal,
          windows: {
            machineEnvironment: {},
            userEnvironment: {},
            profilePaths: [profile],
          },
        });
        const rejected = assert.rejects(pending, error => {
          assert.match(String(error), cancel ? /cancelled/ : /timed out/);
          assert.doesNotMatch(String(error), /private-profile-output/);
          return true;
        });
        if (cancel) {
          for (let index = 0; index < 400; index++) {
            if (
              await access(pidFile).then(
                () => true,
                () => false,
              )
            )
              break;
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          controller.abort();
        }
        await rejected;
        const pid = Number(await readFile(pidFile, 'utf8'));
        for (let index = 0; index < 100; index++) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
      }
    },
  );
}

for (const shell of nativeShells) {
  void test(
    `Windows ${win32.basename(shell)} captures profile exports and cleans background descendants after the shell exits`,
    {timeout: 20000},
    async t => {
      const base = new URL('../.varisdev/test-environment/', import.meta.url);
      await mkdir(base, {recursive: true});
      const directory = await mkdtemp(
        fileURLToPath(new URL('windows-background-', base)),
      );
      const quote = (text: string) => "'" + text.replace(/'/g, "''") + "'";
      const pids = join(directory, 'pids.json');
      const identities = join(directory, 'identities.json');
      const background = join(directory, 'background.mjs');
      await writeFile(
        background,
        `
        import {spawn} from 'node:child_process';
        import {writeFileSync} from 'node:fs';
        const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {stdio: 'inherit'});
        writeFileSync(${JSON.stringify(pids)}, JSON.stringify([process.pid, child.pid]));
        setTimeout(() => {}, 30000);
      `,
      );
      const profile = join(directory, 'profile.ps1');
      await writeFile(
        profile,
        '\ufeff' +
          `
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = ${quote(process.execPath)}
        $info.Arguments = ${quote('"' + background + '"')}
        $info.UseShellExecute = $false
        $info.CreateNoWindow = $true
        $child = [Diagnostics.Process]::Start($info)
        while (![IO.File]::Exists(${quote(pids)})) { Start-Sleep -Milliseconds 10 }
        $ids = ConvertFrom-Json ([IO.File]::ReadAllText(${quote(pids)}))
        $targets = @(foreach ($id in $ids) {
          $p = [Diagnostics.Process]::GetProcessById($id)
          try {
            @{pid = $p.Id; started = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds()}
          } finally { $p.Dispose() }
        })
        [IO.File]::WriteAllText(${quote(identities)}, (ConvertTo-Json -Compress -InputObject $targets))
        $env:BACKGROUND_PROFILE_SETTING = 'captured-after-spawn'
      `,
      );
      // Retain each native handle while verifying creation time before cleanup.
      t.after(async () => {
        const targets = await readFile(identities, 'utf8').catch(() => '[]');
        const cleanup = `
          $targets = ConvertFrom-Json ${quote(targets)}
          foreach ($target in $targets) {
            try { $p = [Diagnostics.Process]::GetProcessById($target.pid) } catch { continue }
            try {
              $null = $p.Handle
              if (([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() -eq $target.started) { $p.Kill() }
            } finally { $p.Dispose() }
          }
          exit 0
        `;
        try {
          await runTerminalProcess(
            shell,
            [
              '-NoLogo',
              '-NoProfile',
              '-NonInteractive',
              '-EncodedCommand',
              Buffer.from(cleanup, 'utf16le').toString('base64'),
            ],
            {
              cwd: directory,
              timeoutMs: 5000,
            },
          );
        } finally {
          await rm(directory, {recursive: true, force: true});
        }
      });
      const values = await readShellEnvironment({
        env: {
          SystemRoot: process.env.SystemRoot,
          HOME: directory,
          USERPROFILE: directory,
          PSExecutionPolicyPreference: 'Bypass',
        },
        shell,
        timeoutMs: 8000,
        windows: {
          machineEnvironment: {},
          userEnvironment: {},
          profilePaths: [profile],
        },
      });
      assert.equal(values.BACKGROUND_PROFILE_SETTING, 'captured-after-spawn');
      const descendants = JSON.parse(await readFile(identities, 'utf8')) as {
        pid: number;
        started: number;
      }[];
      assert.equal(descendants.length, 2);
      for (const {pid} of descendants) {
        for (let index = 0; index < 100; index++) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.throws(() => process.kill(pid, 0), {code: 'ESRCH'});
      }
    },
  );
}
