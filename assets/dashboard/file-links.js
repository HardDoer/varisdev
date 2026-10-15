/* global document, URL */
export function fileLinkPath(target) {
  try {
    const value = target.trim().replace(/^<|>$/g, '');
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      if (url.hostname && url.hostname !== 'localhost') return;
      return decodeURIComponent(url.pathname).replace(/^\/([a-z]:\/)/i, '$1');
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value))
      return;
    if (!value || value.startsWith('#') || value.startsWith('//')) return;
    return decodeURIComponent(value.replace(/#[^#]*$/, ''));
  } catch {
    return undefined;
  }
}

function decodedLabel(label) {
  try {
    return decodeURIComponent(label);
  } catch {
    return label;
  }
}

// Reuse unchanged nodes so streaming messages retain native text selection.
export function renderFileLinks(target, text, updateText) {
  if (target._linkText === text) return false;
  target._linkText = text;
  const parts = [];
  const links = /\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)|file:\/\/[^\s<>`]+/gi;
  let start = 0;
  for (const match of text.matchAll(links)) {
    const path = fileLinkPath(match[2] || match[0]);
    if (!path) continue;
    if (match.index > start) parts.push({text: text.slice(start, match.index)});
    parts.push({
      text: decodedLabel(match[1] || path.split(/[/\\]/).at(-1) || path),
      path,
    });
    start = match.index + match[0].length;
  }
  if (start < text.length || !parts.length)
    parts.push({text: text.slice(start)});
  for (const [index, part] of parts.entries()) {
    let node = target.childNodes[index];
    if (part.path) {
      if (node?.nodeName !== 'A' || node.dataset.filePath !== part.path) {
        const link = document.createElement('a');
        link.href = '#';
        link.dataset.filePath = part.path;
        link.title = part.path;
        if (node) node.replaceWith(link);
        else target.append(link);
        node = link;
      }
      if (node.textContent !== part.text) node.textContent = part.text;
    } else {
      if (node?.nodeType !== 3) {
        const replacement = document.createTextNode('');
        if (node) node.replaceWith(replacement);
        else target.append(replacement);
        node = replacement;
      }
      updateText(node, part.text);
    }
  }
  while (target.childNodes.length > parts.length) target.lastChild.remove();
  return true;
}
