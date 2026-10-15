import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import {DesktopPreferences} from '../src/desktop/preferences.ts';

void test('folder picker remembers the last project across app instances and handles missing folders', async t => {
  const root = join(process.cwd(), '.pi', 'tmp');
  await mkdir(root, {recursive: true});
  const directory = await mkdtemp(join(root, 'preferences-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const profile = join(directory, '.pi', 'desktop');
  const project = join(directory, 'project');
  await mkdir(project);
  const preferences = new DesktopPreferences(profile);
  assert.equal(preferences.folder(directory), directory);
  preferences.rememberFolder(project);
  assert.equal(new DesktopPreferences(profile).folder(directory), project);
  await rm(project, {recursive: true});
  assert.equal(new DesktopPreferences(profile).folder(directory), directory);
  await writeFile(join(profile, 'settings.json'), '{broken');
  assert.equal(new DesktopPreferences(profile).folder(directory), directory);
});

void test('agent notice acknowledgment survives restart and folder changes', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'varisdev-notice-'));
  t.after(() => rm(profile, {recursive: true, force: true}));
  const first = new DesktopPreferences(profile);
  assert.equal(first.agentNoticeAcknowledged(), false);
  assert.equal(first.commitNoticeAcknowledged(), false);
  first.acknowledgeAgentNotice();
  const restarted = new DesktopPreferences(profile);
  assert.equal(restarted.agentNoticeAcknowledged(), true);
  assert.equal(restarted.commitNoticeAcknowledged(), false);
  restarted.acknowledgeCommitNotice();
  restarted.rememberFolder(profile);
  const changed = new DesktopPreferences(profile);
  assert.equal(changed.agentNoticeAcknowledged(), true);
  assert.equal(changed.commitNoticeAcknowledged(), true);
  assert.equal(changed.folder('/unused'), profile);

  await writeFile(
    join(profile, 'settings.json'),
    JSON.stringify({lastFolder: profile, agentNoticeAcknowledged: 'true'}),
  );
  const invalid = new DesktopPreferences(profile);
  assert.equal(invalid.agentNoticeAcknowledged(), false);
  invalid.acknowledgeAgentNotice();
  assert.equal(new DesktopPreferences(profile).folder('/unused'), profile);
});

void test('a failed preference write leaves the agent notice unacknowledged', async t => {
  const profile = await mkdtemp(join(tmpdir(), 'varisdev-notice-failure-'));
  t.after(() => rm(profile, {recursive: true, force: true}));
  const preferences = new DesktopPreferences(profile);
  await mkdir(join(profile, 'settings.json'));
  assert.throws(() => preferences.acknowledgeAgentNotice());
  assert.throws(() => preferences.acknowledgeCommitNotice());
  assert.equal(preferences.agentNoticeAcknowledged(), false);
  assert.equal(preferences.commitNoticeAcknowledged(), false);
  await rm(join(profile, 'settings.json'), {recursive: true});
  preferences.acknowledgeCommitNotice();
  const restarted = new DesktopPreferences(profile);
  assert.equal(restarted.commitNoticeAcknowledged(), true);
  assert.equal(restarted.agentNoticeAcknowledged(), false);
});
