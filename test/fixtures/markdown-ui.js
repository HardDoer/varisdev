/* global window */
import {
  initMarkdownFiles,
  openMarkdownFile,
  updateMarkdownFiles,
} from '../../assets/dashboard/markdown-files.js';
import {flushDrafts} from '../../assets/dashboard/draft-storage.js';

const disks = new Map(
  JSON.parse(window.localStorage.getItem('fixture.markdown-disks') || '[]'),
);
let selection;
let readError;
let saveError;
let delay;
let revision = Math.max(
  0,
  ...[...disks.values()].map(file => Number(file.version) || 0),
);
const key = (sessionId, path) =>
  `${sessionId}:${path.startsWith('/') ? path : `/project/${sessionId}/${path}`}`;
function put(sessionId, path, content) {
  disks.set(key(sessionId, path), {
    path: path.startsWith('/') ? path : `/project/${sessionId}/${path}`,
    content,
    version: String(++revision),
  });
  window.localStorage.setItem(
    'fixture.markdown-disks',
    JSON.stringify([...disks]),
  );
}
function seed(sessionId, path, content) {
  if (!disks.has(key(sessionId, path))) put(sessionId, path, content);
}
seed(
  'one',
  'PLAN.md',
  '# Build plan\n\n- [x] Read instructions\n- [ ] Implement editor\n\n```html\n<script>window.hacked = true</script>\n- [ ] code, not a task\n```\n\n<img src=x onerror="window.hacked=true">\n\n**Strong** and `inline code`.',
);
seed('one', 'NOTES.md', '# Notes\n\n- Review the change');
seed('two', 'PLAN.md', '# Other project\n\n- [ ] Other task');
const api = {
  async sessionFeatures(sessionId) {
    return {
      contextFiles: [
        {path: `/project/${sessionId}/PLAN.md`, status: 'included'},
      ],
    };
  },
  async readMarkdown(sessionId, path) {
    if (delay) await delay;
    if (readError) throw new Error(readError);
    if (sessionId === 'windows')
      return {
        path: ['C:', 'project', 'PLAN.md'].join(String.fromCharCode(92)),
        content: '# Windows plan',
        version: 'windows-base',
      };
    const result = disks.get(key(sessionId, path));
    if (!result) throw new Error('Markdown file not found');
    return {...result};
  },
  async saveMarkdown(sessionId, path, content, version) {
    if (saveError) throw new Error(saveError);
    const existing = disks.get(key(sessionId, path));
    if (!existing || existing.version !== version)
      throw new Error(
        'This Markdown file changed on disk. Reload it before saving your edits.',
      );
    put(sessionId, path, content);
    return {...disks.get(key(sessionId, path))};
  },
};
let originalSetItem;
window.markdownFixture = {
  flush: flushDrafts,
  failDraftWrites(enabled) {
    if (enabled && !originalSetItem) {
      originalSetItem = window.Storage.prototype.setItem;
      window.Storage.prototype.setItem = function (key, value) {
        if (key === 'varisdev.markdown-drafts.v1')
          throw new window.DOMException('Storage full', 'QuotaExceededError');
        return originalSetItem.call(this, key, value);
      };
    } else if (!enabled && originalSetItem) {
      window.Storage.prototype.setItem = originalSetItem;
      originalSetItem = undefined;
    }
  },
  open: openMarkdownFile,
  select(sessionId, cwd = `/project/${sessionId}`) {
    selection = {session: {id: sessionId, cwd}, changes: [{path: 'PLAN.md'}]};
    updateMarkdownFiles();
  },
  put,
  disk: (sessionId, path) => disks.get(key(sessionId, path)),
  readError(value) {
    readError = value;
  },
  saveError(value) {
    saveError = value;
  },
  delay(value) {
    delay = value;
  },
};
initMarkdownFiles({api, selected: () => selection});
window.markdownFixture.select('one');
window.markdownReady = true;
