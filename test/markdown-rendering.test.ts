import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {test} from 'node:test';
import {renderMarkdown} from '../assets/dashboard/markdown-files.js';

class TestNode {
  readonly children: TestNode[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  href = '';
  title = '';
  className = '';
  textContent = '';
  tagName: string;

  constructor(tagName = '') {
    this.tagName = tagName.toUpperCase();
  }
  append(...children: TestNode[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: TestNode[]) {
    this.children.splice(0, this.children.length, ...children);
  }
  setAttribute() {}
  get text(): string {
    return this.textContent + this.children.map(child => child.text).join('');
  }
  descendants(): TestNode[] {
    return [this, ...this.children.flatMap(child => child.descendants())];
  }
}

function withDocument(check: () => void) {
  const previous = globalThis.document;
  const document = {
    createElement: (tag: string) => new TestNode(tag),
    createTextNode: (text: string) => {
      const item = new TestNode();
      item.textContent = text;
      return item;
    },
    createDocumentFragment: () => new TestNode(),
  };
  Object.assign(globalThis, {document});
  try {
    check();
  } finally {
    Object.assign(globalThis, {document: previous});
  }
}

void test('Markdown preview scans long unclosed delimiter runs linearly', () => {
  withDocument(() => {
    for (const content of [
      '['.repeat(80_000),
      `plain ${'`'.repeat(80_000)}`,
      '[a]('.repeat(20_000),
    ]) {
      const target = new TestNode();
      const started = performance.now();
      renderMarkdown(target, content);
      const elapsed = performance.now() - started;
      assert.equal(target.text, content);
      assert.ok(elapsed < 1000, `Malformed preview took ${elapsed} ms`);
    }
    const multiline = new TestNode();
    const content = '**first\nsecond**\n[label\nnext](file.txt)';
    renderMarkdown(multiline, content);
    assert.equal(multiline.text, content);
    assert.equal(
      multiline
        .descendants()
        .some(item => item.tagName === 'STRONG' || item.className),
      false,
    );
  });
});

void test('Markdown conversation links preserve Windows targets and route web links', () => {
  withDocument(() => {
    const target = new TestNode();
    const content =
      '[copy](C:/Project/src/main(copy).js) [angle](<C:/Project Files/a (copy).js>) [web](https://example.com/guide_(Windows)) [unsafe](javascript:alert(1))';
    renderMarkdown(target, content, true);
    const links = target.descendants().filter(item => item.tagName === 'A');
    assert.deepEqual(
      links.map(link => ({text: link.text, ...link.dataset})),
      [
        {text: 'copy', filePath: 'C:/Project/src/main(copy).js'},
        {text: 'angle', filePath: 'C:/Project Files/a (copy).js'},
        {text: 'web', externalUrl: 'https://example.com/guide_(Windows)'},
      ],
    );
    assert.equal(links[2].href, 'https://example.com/guide_(Windows)');
    assert.equal(target.text, 'copy angle web unsafe');
    renderMarkdown(target, content);
    assert.equal(
      target.descendants().filter(item => item.tagName === 'A').length,
      0,
    );
    assert.equal(target.text, 'copy angle web unsafe');
  });
});
