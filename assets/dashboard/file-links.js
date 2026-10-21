/* global document, URL */
function linkTarget(target) {
  const value = target.trim();
  return value.startsWith('<') && value.endsWith('>')
    ? value.slice(1, -1)
    : value;
}

function drivePath(path) {
  return path.replace(/^\/([a-z]:[/\\])/i, '$1');
}

export function fileLinkPath(target) {
  try {
    const value = linkTarget(target);
    if (/^file:/i.test(value)) {
      const url = new URL(value);
      const path = decodeURIComponent(url.pathname);
      if (url.hostname && url.hostname !== 'localhost')
        return `//${url.hostname}${path}`;
      return drivePath(path);
    }
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value))
      return;
    if (!value || value.startsWith('#') || value.startsWith('//')) return;
    return drivePath(decodeURIComponent(value.replace(/#[^#]*$/, '')));
  } catch {
    return undefined;
  }
}

export function externalLinkURL(target) {
  try {
    const value = linkTarget(target);
    if (!/^https?:\/\//i.test(value) || /[\s\p{Cc}]/u.test(value)) return;
    return new URL(value).href;
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

// Index parentheses once so incomplete, nested targets remain linear to scan.
export function markdownLinks(text) {
  const parentheses = new Map();
  const stack = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === '\n') stack.length = 0;
    else if (text[index] === '(') stack.push(index);
    else if (text[index] === ')' && stack.length)
      parentheses.set(stack.pop(), index);
  }
  const links = new Map();
  const openings = /\[/g;
  let labelEnd = -1;
  let lineEnd = -1;
  let angleEnd = -1;
  for (let match; (match = openings.exec(text));) {
    const index = match.index;
    if (lineEnd <= index) {
      lineEnd = text.indexOf('\n', index + 1);
      if (lineEnd < 0) lineEnd = text.length;
    }
    if (labelEnd <= index) {
      labelEnd = text.indexOf(']', index + 1);
      if (labelEnd < 0) labelEnd = text.length;
    }
    if (
      labelEnd <= index + 1 ||
      labelEnd >= lineEnd ||
      text[labelEnd + 1] !== '('
    )
      continue;
    const targetStart = labelEnd + 2;
    let targetEnd = parentheses.get(labelEnd + 1);
    if (text[targetStart] === '<') {
      if (angleEnd < targetStart) {
        angleEnd = text.indexOf('>', targetStart + 1);
        if (angleEnd < 0) angleEnd = text.length;
      }
      targetEnd = text[angleEnd + 1] === ')' ? angleEnd + 1 : undefined;
    }
    if (
      targetEnd === undefined ||
      targetEnd <= targetStart ||
      targetEnd >= lineEnd
    )
      continue;
    links.set(index, {
      label: text.slice(index + 1, labelEnd),
      target: text.slice(targetStart, targetEnd),
      end: targetEnd + 1,
    });
    openings.lastIndex = targetEnd + 1;
  }
  return links;
}

function codeFilePath(value) {
  if (/^file:/i.test(value)) return fileLinkPath(value);
  // Code may contain commands and expressions as well as filenames.
  if (!value || /[\r\n<>"|?*]/.test(value)) return;
  const rooted = /^(?:\/?[a-z]:[/\\]|[/\\]|\.{1,2}[/\\]|~[/\\])/i.test(value);
  const whitespace = value.search(/\s/);
  const separator = value.search(/[/\\]/);
  if (whitespace >= 0 && !rooted && (separator < 0 || whitespace < separator))
    return;
  if (/\s(?:--?\w|&&|\|\|)/.test(value)) return;
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value)) return;
  if (!rooted && !/[/\\]|^[\w.-]+\.[a-z][a-z\d]*$|^\.[\w.-]+$/i.test(value))
    return;
  return drivePath(value);
}

function trimURLPunctuation(value) {
  let result = value.replace(/[.,;:!?]+$/, '');
  for (const [open, close] of [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
  ]) {
    let balance = 0;
    for (const character of result) {
      if (character === open) balance++;
      else if (character === close) balance--;
    }
    while (balance < 0 && result.endsWith(close)) {
      result = result.slice(0, -1);
      balance++;
    }
  }
  return result;
}

export function fileLinkParts(text) {
  const parts = [];
  const links = markdownLinks(text);
  const openings = /\[|`+|(?:file|https?):\/\//gi;
  const uri = /[^\s<>`]+/y;
  let start = 0;
  for (let match; (match = openings.exec(text));) {
    const index = match.index;
    let end;
    let label;
    let target;
    let literal = false;
    if (match[0] === '[') {
      const link = links.get(index);
      if (!link) continue;
      ({label, target, end} = link);
    } else if (match[0][0] === '`') {
      // Fenced code is output, rather than a list of file references.
      if (match[0].length >= 3) {
        const close = text.indexOf(match[0], openings.lastIndex);
        openings.lastIndex = close < 0 ? text.length : close + match[0].length;
        continue;
      }
      const close = text.indexOf(match[0], openings.lastIndex);
      if (close < 0) continue;
      target = text.slice(openings.lastIndex, close);
      end = close + match[0].length;
      label = target;
      literal = true;
    } else {
      uri.lastIndex = openings.lastIndex;
      const value = uri.exec(text);
      if (!value) continue;
      const candidate = text.slice(index, uri.lastIndex);
      target =
        /^file:/i.test(candidate) ||
        (text[index - 1] === '<' && text[uri.lastIndex] === '>')
          ? candidate
          : trimURLPunctuation(candidate);
      end = index + target.length;
    }
    openings.lastIndex = end;
    const url = externalLinkURL(target);
    const path =
      !url && (literal ? codeFilePath(target) : fileLinkPath(target));
    if (!path && !url) continue;
    if (index > start) parts.push({text: text.slice(start, index)});
    parts.push({
      text:
        label !== undefined
          ? literal
            ? label
            : decodedLabel(label)
          : url
            ? target
            : path.split(/[/\\]/).at(-1) || path,
      ...(path ? {path} : {url}),
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
    if (part.path || part.url) {
      if (
        node?.nodeName !== 'A' ||
        node.dataset.filePath !== part.path ||
        node.dataset.externalUrl !== part.url
      ) {
        const link = document.createElement('a');
        link.href = part.url || '#';
        if (part.path) link.dataset.filePath = part.path;
        else link.dataset.externalUrl = part.url;
        link.title = part.path || part.url;
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

export function bindConversationLinks(target, options) {
  const click = async event => {
    const link = event.target.closest(
      'a[data-file-path], a[data-external-url]',
    );
    if (!link || !target.contains(link)) return;
    event.preventDefault();
    try {
      if (link.dataset.externalUrl)
        await options.openExternal(link.dataset.externalUrl);
      else if (/\.md$/i.test(link.dataset.filePath))
        await options.openMarkdown(link.dataset.filePath);
      else await options.openFile(options.sessionId(), link.dataset.filePath);
    } catch (error) {
      options.onError(error);
    }
  };
  target.addEventListener('click', click);
  return () => target.removeEventListener('click', click);
}
