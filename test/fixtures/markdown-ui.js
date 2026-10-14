/* global window */
import {
  initMarkdownFiles,
  openMarkdownFile,
  updateMarkdownFiles,
} from '../../assets/dashboard/markdown-files.js';

const disks = new Map();
let selection;
let readError;
let saveError;
let delay;
let revision = 0;
const key = (sessionId, path) =>
  `${sessionId}:${path.startsWith('/') ? path : `/project/${sessionId}/${path}`}`;
function put(sessionId, path, content) {
  disks.set(key(sessionId, path), {
    path: path.startsWith('/') ? path : `/project/${sessionId}/${path}`,
    content,
    version: String(++revision),
  });
}
put(
  'one',
  'PLAN.md',
  '# Build plan\n\n- [x] Read instructions\n- [ ] Implement editor\n\n```html\n<script>window.hacked = true</script>\n- [ ] code, not a task\n```\n\n<img src=x onerror="window.hacked=true">\n\n**Strong** and `inline code`.',
);
put('one', 'NOTES.md', '# Notes\n\n- Review the change');
put('two', 'PLAN.md', '# Other project\n\n- [ ] Other task');
const api = {
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
window.markdownFixture = {
  open: openMarkdownFile,
  select(sessionId, cwd = `/project/${sessionId}`) {
    selection = {session: {id: sessionId, cwd}};
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
