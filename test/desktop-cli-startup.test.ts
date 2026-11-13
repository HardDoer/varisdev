import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {test} from 'node:test';
import {runRuntimeCommand} from '../src/runtime/manager.ts';

void test(
  'opening the desktop leaves runtime cleanup to the ready app',
  {timeout: 30000},
  async t => {
    const temporaryRoot = join(process.cwd(), '.varisdev/tool-output');
    await mkdir(temporaryRoot, {recursive: true});
    const directory = await mkdtemp(join(temporaryRoot, 'cli-startup-'));
    t.after(() => rm(directory, {recursive: true, force: true}));
    const electron = join(directory, 'node_modules/electron');
    const desktop = join(directory, 'desktop/build/src/desktop');
    await Promise.all(
      [electron, desktop].map(path => mkdir(path, {recursive: true})),
    );
    await writeFile(
      join(directory, 'package.json'),
      '{"name":"varisdev","version":"1.0.0","type":"module"}',
    );
    await writeFile(join(electron, 'package.json'), '{"main":"index.cjs"}');
    await writeFile(
      join(electron, 'index.cjs'),
      `module.exports = ${JSON.stringify(process.execPath)};`,
    );
    await writeFile(
      join(desktop, 'main.js'),
      `
    process.on('disconnect', () => process.exit(0));
    process.send({type: 'ready'});
  `,
    );
    const script = `
    import assert from 'node:assert/strict';
    import {RuntimeManager} from ${JSON.stringify(new URL('../src/runtime/manager.ts', import.meta.url).href)};
    import {runCli} from ${JSON.stringify(new URL('../src/runtime/cli.ts', import.meta.url).href)};
    RuntimeManager.prototype.cleanupRuntimes = async () => {
      throw new Error('Runtime cleanup blocked desktop startup.');
    };
    assert.equal(await runCli(['--overview'], ${JSON.stringify(directory)}), 0);
    console.log('desktop-ready');
  `;
    const env = {
      ...process.env,
      LOCALAPPDATA: directory,
      HOME: directory,
      USERPROFILE: directory,
      XDG_CONFIG_HOME: directory,
      VARISDEV_DATA_DIR: join(directory, 'data'),
      PIDEV_DESKTOP_DATA_DIR: join(directory, 'profile'),
      VARISDEV_SETTINGS_DIR: join(directory, 'agent'),
      VARISDEV_RESTART_PID: '',
    };
    const output = await runRuntimeCommand(
      process.execPath,
      ['--input-type=module', '-e', script],
      {
        cwd: directory,
        env,
        timeoutMs: 20000,
      },
    );
    assert.match(output, /desktop-ready/);
  },
);
