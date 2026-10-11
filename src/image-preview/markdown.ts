import {Marked, type Token} from '@earendil-works/pi-tui';
import {resolveImagePath} from './files.ts';

const marked = new Marked();

/** Keep the original Markdown and code examples; replace only parsed image links. */
export function rewriteImageLinks(
  markdown: string,
  cwd: string,
  preview: (path: string) => string,
): string {
  const skipped = new Set<Token>();
  let cursor = 0;
  let result = '';
  void marked.walkTokens(marked.lexer(markdown), token => {
    if (skipped.has(token)) return;
    if (!['link', 'image', 'code', 'codespan', 'html'].includes(token.type))
      return;
    // A link or protected block owns its whole source, including nested tokens.
    void marked.walkTokens([token], child => {
      skipped.add(child);
    });
    const start = markdown.indexOf(token.raw, cursor);
    if (start < 0) return;
    let replacement = token.raw;
    if (token.type === 'link' || token.type === 'image') {
      const path = resolveImagePath(token.href, cwd, true);
      if (path) {
        // Pi renders Markdown links, but does not display Markdown image syntax.
        const label = token.text || 'Open image';
        replacement = `[${label}](${preview(path)})`;
      }
    }
    result += markdown.slice(cursor, start) + replacement;
    cursor = start + token.raw.length;
  });
  return result + markdown.slice(cursor);
}
