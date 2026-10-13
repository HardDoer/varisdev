import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
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
