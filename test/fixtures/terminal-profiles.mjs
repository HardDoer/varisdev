import assert from 'node:assert/strict';
import console from 'node:console';
import {access, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import process from 'node:process';
import {setTimeout as delay} from 'node:timers/promises';
import {
  environmentPath,
  environmentSettings,
} from '../../src/runtime/environment.mjs';
import {DesktopTerminals} from '../../src/desktop/terminal.ts';

const [home, project, kind] = process.argv.slice(2);
const loginValue = `${kind}-login`;
const rcValue = `${kind}-rc`;
const file = environmentPath();

// These checks run as the desktop application entry, after the real bootstrap.
assert.equal(process.env.HOME, home);
assert.equal(process.env.TERMINAL_LOGIN_VALUE, loginValue);
assert.equal(process.env.TERMINAL_PROFILE_VALUE, rcValue);
assert.ok(process.env.PATH.split(':').includes(join(home, 'profile bin')));
const settings = environmentSettings();
const initial = await settings.get();
assert.equal(initial.error, undefined);
assert.equal(initial.values.TERMINAL_LOGIN_VALUE, loginValue);
assert.equal(initial.values.TERMINAL_PROFILE_VALUE, rcValue);
assert.deepEqual(initial.savedNames, []);
await assert.rejects(access(file), {code: 'ENOENT'});

const terminals = new DesktopTerminals(() => {});
try {
  await terminals.open('profile', project);
  terminals.resize('profile', 240, 24);
  terminals.write(
    'profile',
    [
      'profile_alias',
      'profile_function',
      'printf "PROFILE_LOGIN=%s\\n" "$TERMINAL_LOGIN_VALUE"',
      'printf "PROFILE_RC=%s\\n" "$TERMINAL_PROFILE_VALUE"',
      'printf "PROFILE_PATH=%s\\n" "$PATH"',
      'printf "PROFILE_CWD="; pwd -P',
      'case $- in *i*) printf "PROFILE_INTERACTIVE=%s\\n" yes ;; esac',
    ].join('\r') + '\r',
  );
  const expected = [
    `PROFILE_ALIAS=${kind}-alias`,
    `PROFILE_FUNCTION=${rcValue}`,
    `PROFILE_LOGIN=${loginValue}`,
    `PROFILE_RC=${rcValue}`,
    `PROFILE_CWD=${project}`,
    'PROFILE_INTERACTIVE=yes',
  ];
  let snapshot;
  let lines = [];
  for (let attempt = 0; attempt < 160; attempt++) {
    snapshot = await terminals.open('profile', project);
    lines = snapshot.data.split(/[\r\n]+/);
    if (expected.every(line => lines.includes(line))) break;
    assert.equal(snapshot.exitCode, undefined, snapshot.data);
    await delay(25);
  }
  for (const line of expected) assert.ok(lines.includes(line), snapshot.data);
  const pathLine = lines.find(line => line.startsWith('PROFILE_PATH='));
  assert.ok(
    pathLine
      ?.slice('PROFILE_PATH='.length)
      .split(':')
      .includes(join(home, 'profile bin')),
    snapshot.data,
  );
} finally {
  terminals.dispose();
}

await settings.get();
await assert.rejects(access(file), {code: 'ENOENT'});
const saved = await settings.save(
  'TERMINAL_PROFILE_VALUE',
  'explicit-user-value',
);
assert.equal(saved.values.TERMINAL_PROFILE_VALUE, 'explicit-user-value');
assert.deepEqual(saved.savedNames, ['TERMINAL_PROFILE_VALUE']);
assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
  TERMINAL_PROFILE_VALUE: 'explicit-user-value',
});
await settings.get();
assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), {
  TERMINAL_PROFILE_VALUE: 'explicit-user-value',
});
const removed = await settings.save('TERMINAL_PROFILE_VALUE', null);
assert.equal(removed.values.TERMINAL_PROFILE_VALUE, rcValue);
assert.equal(process.env.TERMINAL_PROFILE_VALUE, rcValue);
assert.deepEqual(removed.savedNames, []);
await assert.rejects(access(file), {code: 'ENOENT'});
console.log('terminal-profiles-ready');
