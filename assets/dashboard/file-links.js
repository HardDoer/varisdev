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

export function fileLinkParts(text) {
  const parts = [];
  const openings = /\[|file:\/\//gi;
  const uri = /[^\s<>`]+/y;
  const endings = new Map();
  // Reuse forward searches when many opening delimiters have no closing pair.
  const next = (character, from) => {
    let position = endings.get(character);
    if (position === undefined || position < from) {
      position = text.indexOf(character, from);
      if (position < 0) position = text.length;
      endings.set(character, position);
    }
    return position;
  };
  let start = 0;
  for (let match; (match = openings.exec(text));) {
    const index = match.index;
    let end;
    let label;
    let target;
    if (match[0] === '[') {
      const lineEnd = next('\n', index + 1);
      const labelEnd = next(']', index + 1);
      if (
        labelEnd <= index + 1 ||
        labelEnd >= lineEnd ||
        text[labelEnd + 1] !== '('
      )
        continue;
      const targetStart = labelEnd + 2;
      let targetEnd = next(')', targetStart);
      if (text[targetStart] === '<') {
        const angleEnd = next('>', targetStart + 1);
        if (
          angleEnd > targetStart + 1 &&
          angleEnd < lineEnd &&
          text[angleEnd + 1] === ')'
        )
          targetEnd = angleEnd + 1;
      }
      if (targetEnd <= targetStart || targetEnd >= lineEnd) continue;
      label = text.slice(index + 1, labelEnd);
      target = text.slice(targetStart, targetEnd);
      end = targetEnd + 1;
    } else {
      uri.lastIndex = openings.lastIndex;
      const value = uri.exec(text);
      if (!value) continue;
      end = uri.lastIndex;
      target = text.slice(index, end);
    }
    openings.lastIndex = end;
    const path = fileLinkPath(target);
    if (!path) continue;
    if (index > start) parts.push({text: text.slice(start, index)});
    parts.push({
      text: decodedLabel(label || path.split(/[/\\]/).at(-1) || path),
      path,
    });
    start = end;
  }
  if (start < text.length || !parts.length)
    parts.push({text: text.slice(start)});
  return parts;
}

// Reuse unchanged nodes so streaming messages retain native text selection.
export function renderFileLinks(target, text, updateText) {
  if (target._linkText === text) return false;
  target._linkText = text;
  const parts = fileLinkParts(text);
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
