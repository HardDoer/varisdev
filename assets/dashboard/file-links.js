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

export function fileLinkParts(text, ranges) {
  const parts = [];
  const links = markdownLinks(text);
  const openings = /\\[\\*_`]|\*{2,}|_{2,}|\[|`+|~{3,}|(?:file|https?):\/\//gi;
  const uri = /[^\s<>`]+/y;
  let start = 0;
  const strong = new Map();
  for (let match; (match = openings.exec(text));) {
    const index = match.index;
    let end;
    let label;
    let target;
    let literal = false;
    const marker = match[0];
    if (marker[0] === '\\') continue;
    if (marker[0] === '*' || marker[0] === '_') {
      if (marker.length !== 2) continue;
      const before = text[index - 1] || '';
      const after = text[index + 2] || '';
      const canOpen =
        /\S/.test(after) && (marker === '**' || !/[\p{L}\p{N}_]/u.test(before));
      const canClose =
        /\S/.test(before) && (marker === '**' || !/[\p{L}\p{N}_]/u.test(after));
      if (index > start)
        parts.push({text: text.slice(start, index), source: start});
      const delimiter = {text: marker, source: index};
      const opening = strong.get(marker);
      if (opening !== undefined && canClose) {
        parts[opening].boundary = 1;
        delimiter.boundary = -1;
        strong.delete(marker);
      } else if (opening === undefined && canOpen)
        strong.set(marker, parts.length);
      parts.push(delimiter);
      start = openings.lastIndex;
      continue;
    }
    if (
      (marker[0] === '`' || marker[0] === '~') &&
      marker.length >= 3 &&
      /(?:^|\n) {0,3}$/.test(text.slice(Math.max(0, index - 4), index))
    ) {
      const closing = new RegExp(
        `(?:^|\\n) {0,3}${marker[0]}{${marker.length},}[ \\t]*(?:\\r?\\n|$)`,
        'g',
      );
      closing.lastIndex = openings.lastIndex;
      const close = closing.exec(text);
      openings.lastIndex = close ? closing.lastIndex : text.length;
      continue;
    }
    if (marker[0] === '~') continue;
    if (match[0] === '[') {
      const link = links.get(index);
      if (!link) continue;
      ({label, target, end} = link);
    } else if (match[0][0] === '`') {
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
      let candidate = text.slice(index, uri.lastIndex);
      for (const marker of strong.keys()) {
        let close = candidate.indexOf(marker);
        while (close >= 0) {
          if (
            marker === '**' ||
            !/[\p{L}\p{N}_]/u.test(candidate[close + 2] || '')
          ) {
            candidate = candidate.slice(0, close);
            break;
          }
          close = candidate.indexOf(marker, close + 2);
        }
      }
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
    if (index > start)
      parts.push({text: text.slice(start, index), source: start});
    parts.push({
      source: index + (label === undefined ? 0 : literal ? marker.length : 1),
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
    parts.push({text: text.slice(start), source: start});
  // Unpaired delimiters stay visible while a response is still streaming.
  const formatted = [];
  let bold = 0;
  let display = 0;
  for (const {source, ...part} of parts) {
    if (part.boundary !== undefined) {
      bold += part.boundary;
      continue;
    }
    ranges?.push({source, display, length: part.text.length});
    display += part.text.length;
    if (bold) part.strong = true;
    const previous = formatted.at(-1);
    if (
      previous &&
      !previous.path &&
      !previous.url &&
      !part.path &&
      !part.url &&
      previous.strong === part.strong
    )
      previous.text += part.text;
    else formatted.push(part);
  }
  return formatted;
}

function mapOffset(ranges, offset, from, to) {
  for (const range of ranges) {
    if (offset <= range[from] + range.length)
      return range[to] + Math.max(0, offset - range[from]);
  }
  const last = ranges.at(-1);
  return last ? last[to] + last.length : 0;
}

function textPosition(target, offset) {
  const walker = document.createTreeWalker(target, 4); // SHOW_TEXT
  let last;
  for (let node; (node = walker.nextNode());) {
    if (offset <= node.length) return [node, offset];
    offset -= node.length;
    last = node;
  }
  return last ? [last, last.length] : [target, 0];
}

// Reuse unchanged nodes and map selection through newly completed formatting.
export function renderFileLinks(target, text, updateText) {
  if (target._linkText === text) return false;
  const selection = target.ownerDocument.getSelection();
  let endpoints;
  if (
    selection &&
    !selection.isCollapsed &&
    (target.contains(selection.anchorNode) ||
      target.contains(selection.focusNode))
  ) {
    const ranges = [];
    fileLinkParts(target._linkText || '', ranges);
    endpoints = ['anchor', 'focus'].map(end => {
      const node = selection[`${end}Node`];
      const offset = selection[`${end}Offset`];
      if (!target.contains(node)) return {position: [node, offset]};
      const range = document.createRange();
      range.selectNodeContents(target);
      range.setEnd(node, offset);
      return {
        source: mapOffset(ranges, range.toString().length, 'display', 'source'),
      };
    });
  }
  target._linkText = text;
  const ranges = endpoints ? [] : undefined;
  const parts = fileLinkParts(text, ranges);
  for (const [index, part] of parts.entries()) {
    let parent = target;
    let node = target.childNodes[index];
    if (part.strong) {
      if (node?.nodeName !== 'STRONG') {
        const strong = document.createElement('strong');
        if (node) node.replaceWith(strong);
        else target.append(strong);
        node = strong;
      }
      parent = node;
      node = parent.firstChild;
    }
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
        else parent.append(link);
        node = link;
      }
      if (node.textContent !== part.text) node.textContent = part.text;
    } else {
      if (node?.nodeType !== 3) {
        const replacement = document.createTextNode('');
        if (node) node.replaceWith(replacement);
        else parent.append(replacement);
        node = replacement;
      }
      updateText(node, part.text);
    }
  }
  while (target.childNodes.length > parts.length) target.lastChild.remove();
  if (endpoints) {
    const [anchor, focus] = endpoints.map(
      end =>
        end.position ||
        textPosition(
          target,
          mapOffset(ranges, end.source, 'source', 'display'),
        ),
    );
    selection.setBaseAndExtent(...anchor, ...focus);
  }
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
