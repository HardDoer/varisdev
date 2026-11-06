import assert from 'node:assert/strict';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test, type TestContext} from 'node:test';
import {DesktopPreferences} from '../src/desktop/preferences.ts';
import {DesktopWhatsNew} from '../src/desktop/whats-new.ts';

const version = '1.11.0';
const release = {
  version,
  changes: [
    'Release notes appear after installing a new version.',
    'Reopen release notes from Menu → What’s new.',
  ],
};

async function temporaryDirectory(t: TestContext) {
  const root = fileURLToPath(
    new URL('../.varisdev/tool-output/', import.meta.url),
  );
  await mkdir(root, {recursive: true});
  const directory = await realpath(
    await mkdtemp(join(root, 'whats-new-test-')),
  );
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}

void test('release notes use the exact running version without saving on read', async t => {
  const profile = await temporaryDirectory(t);
  const preferences = new DesktopPreferences(profile);
  const whatsNew = new DesktopWhatsNew(preferences, version);
  assert.deepEqual(whatsNew.get(), {release, seen: false});
  assert.deepEqual(await readdir(profile), []);

  const returned = whatsNew.get();
  returned.release!.changes.push('Changed externally.');
  returned.release!.version = '1.12.0';
  assert.deepEqual(whatsNew.get(), {release, seen: false});
});

void test('seen release persists across app instances, folder changes, and agent notice changes', async t => {
  const directory = await temporaryDirectory(t);
  const profile = join(directory, 'profile');
  const first = join(directory, 'first');
  const second = join(directory, 'second');
  await mkdir(first);
  await mkdir(second);
  const preferences = new DesktopPreferences(profile);
  preferences.rememberFolder(first);
  assert.deepEqual(
    new DesktopWhatsNew(preferences, version).markSeen(version),
    {
      release,
      seen: true,
    },
  );
  assert.equal(preferences.agentNoticeAcknowledged(), false);
  assert.equal(preferences.folder('/unused'), first);
  assert.deepEqual(preferences.recentProjects(), [first]);

  const restarted = new DesktopPreferences(profile);
  assert.deepEqual(new DesktopWhatsNew(restarted, version).get(), {
    release,
    seen: true,
  });
  restarted.rememberFolder(second);
  const changed = new DesktopPreferences(profile);
  assert.equal(new DesktopWhatsNew(changed, version).get().seen, true);
  changed.acknowledgeAgentNotice();

  const acknowledged = new DesktopPreferences(profile);
  assert.equal(new DesktopWhatsNew(acknowledged, version).get().seen, true);
  assert.equal(acknowledged.agentNoticeAcknowledged(), true);
  assert.equal(acknowledged.folder('/unused'), second);
  assert.deepEqual(acknowledged.recentProjects(), [second, first]);
  new DesktopWhatsNew(acknowledged, version).markSeen(version);
  const saved = new DesktopPreferences(profile);
  assert.equal(saved.agentNoticeAcknowledged(), true);
  assert.deepEqual(saved.recentProjects(), [second, first]);
  assert.equal(saved.folder('/unused'), second);
  assert.equal(new DesktopWhatsNew(saved, version).get().seen, true);
});

void test('an older seen release leaves the running release unseen', async t => {
  const profile = await temporaryDirectory(t);
  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({lastSeenReleaseVersion: '1.10.2'}),
  );
  const preferences = new DesktopPreferences(profile);
  assert.equal(preferences.whatsNewSeen('1.10.2'), true);
  const whatsNew = new DesktopWhatsNew(preferences, version);
  assert.deepEqual(whatsNew.get(), {release, seen: false});
  whatsNew.markSeen(version);
  const restarted = new DesktopPreferences(profile);
  assert.equal(restarted.whatsNewSeen('1.10.2'), false);
  assert.equal(new DesktopWhatsNew(restarted, version).get().seen, true);
});

void test('versions without bundled notes cannot return or acknowledge another release', async t => {
  const profile = await temporaryDirectory(t);
  const path = join(profile, 'settings.json');
  const saved = JSON.stringify({lastSeenReleaseVersion: '1.13.0'});
  await writeFile(path, saved);
  const preferences = new DesktopPreferences(profile);
  for (const unknown of [
    '',
    '1.10.2',
    '1.11.1',
    '1.13.0',
    '1.11.0-beta.1',
    'v1.11.0',
    'constructor',
    '__proto__',
  ]) {
    const whatsNew = new DesktopWhatsNew(preferences, unknown);
    assert.deepEqual(whatsNew.get(), {release: undefined, seen: false});
    assert.throws(() => whatsNew.markSeen(unknown), /running version/);
    assert.throws(() => whatsNew.markSeen(version), /running version/);
  }
  assert.equal(await readFile(path, 'utf8'), saved);
});

void test('invalid acknowledgements leave the release unseen and do not save preferences', async t => {
  const profile = await temporaryDirectory(t);
  const preferences = new DesktopPreferences(profile);
  const whatsNew = new DesktopWhatsNew(preferences, version);
  for (const invalid of [
    undefined,
    null,
    1110,
    true,
    {},
    [],
    [version],
    {version},
    '',
    '1.10.2',
    '1.12.0',
    ` ${version}`,
    `${version}\n`,
    `${version}-beta.1`,
  ]) {
    assert.throws(() => whatsNew.markSeen(invalid), /running version/);
    assert.deepEqual(whatsNew.get(), {release, seen: false});
    assert.deepEqual(await readdir(profile), []);
  }
});

void test('malformed saved release versions are discarded while other preferences survive', async t => {
  const directory = await temporaryDirectory(t);
  const invalidVersions: unknown[] = [
    undefined,
    null,
    1110,
    true,
    {},
    [],
    [version],
    '',
    '1.11',
    ` ${version}`,
    `${version}\n`,
    'x'.repeat(129),
    '__proto__',
  ];
  for (const [index, invalid] of invalidVersions.entries()) {
    const profile = join(directory, String(index));
    await mkdir(profile);
    const path = join(profile, 'settings.json');
    await writeFile(
      path,
      JSON.stringify({
        lastFolder: directory,
        agentNoticeAcknowledged: true,
        lastSeenReleaseVersion: invalid,
      }),
    );
    const preferences = new DesktopPreferences(profile);
    assert.deepEqual(new DesktopWhatsNew(preferences, version).get(), {
      release,
      seen: false,
    });
    assert.equal(preferences.agentNoticeAcknowledged(), true);
    assert.equal(preferences.folder('/unused'), directory);
    preferences.rememberFolder(directory);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(saved.lastSeenReleaseVersion, undefined);
  }
});

void test('malformed preferences start with unseen release notes', async t => {
  const profile = await temporaryDirectory(t);
  const path = join(profile, 'settings.json');
  for (const malformed of ['{broken', 'null', 'true', '42', '[]', '"text"']) {
    await writeFile(path, malformed);
    const preferences = new DesktopPreferences(profile);
    const whatsNew = new DesktopWhatsNew(preferences, version);
    assert.deepEqual(whatsNew.get(), {release, seen: false});
    whatsNew.markSeen(version);
    assert.equal(
      new DesktopWhatsNew(new DesktopPreferences(profile), version).get().seen,
      true,
    );
  }
});

void test('failed release saves preserve memory and clean up the temporary file', async t => {
  const directory = await temporaryDirectory(t);
  const profile = join(directory, 'profile');
  await mkdir(profile);
  const path = join(profile, 'settings.json');
  await writeFile(
    path,
    JSON.stringify({
      lastFolder: directory,
      agentNoticeAcknowledged: true,
      lastSeenReleaseVersion: '1.10.2',
    }),
  );
  const preferences = new DesktopPreferences(profile);
  const whatsNew = new DesktopWhatsNew(preferences, version);
  await rm(path);
  await mkdir(path);
  assert.throws(() => whatsNew.markSeen(version));
  assert.deepEqual(whatsNew.get(), {release, seen: false});
  assert.equal(preferences.whatsNewSeen('1.10.2'), true);
  assert.equal(preferences.agentNoticeAcknowledged(), true);
  assert.equal(preferences.folder('/unused'), directory);
  assert.deepEqual(preferences.recentProjects(), [directory]);
  assert.deepEqual(await readdir(profile), ['settings.json']);

  await rm(path, {recursive: true});
  whatsNew.markSeen(version);
  assert.equal(
    new DesktopWhatsNew(new DesktopPreferences(profile), version).get().seen,
    true,
  );
  assert.deepEqual(await readdir(profile), ['settings.json']);
});
