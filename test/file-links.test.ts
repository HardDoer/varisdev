import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, normalize} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {fileLinkParts, fileLinkPath} from '../assets/dashboard/file-links.js';
import {openConversationFile} from '../src/desktop/files.ts';

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
      {text: '\n[web](https://example.com).'},
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
    'file://server/share/file.txt',
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
