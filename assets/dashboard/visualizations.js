/* global document, window */
import {renderMarkdown} from './markdown-files.js';

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Snapshots contain references only. Raster data enters through the desktop bridge.
export function createConversationVisualizations({api, root, dialog}) {
  const cache = new Map();
  const pending = new Map();
  const queue = [];
  const entries = new Set();
  let active = 0;
  let cacheSize = 0;
  let generation = 0;
  let viewerVersion = 0;
  let viewerEntry;
  let previousFocus;
  const title = dialog.querySelector('#conversation-image-title');
  const metadata = dialog.querySelector('#conversation-image-metadata');
  const image = dialog.querySelector('img');
  const status = dialog.querySelector('[role=status]');
  const retry = dialog.querySelector('#conversation-image-retry');
  const closeButton = dialog.querySelector('#conversation-image-close');
  const observer = new window.IntersectionObserver(
    records => {
      for (const record of records) {
        if (!record.isIntersecting) continue;
        observer.unobserve(record.target);
        record.target.loadImage?.();
      }
    },
    {root, rootMargin: '240px'},
  );

  function startQueued() {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      if (job.version !== generation) {
        job.reject(new Error('Conversation changed.'));
        continue;
      }
      active++;
      void Promise.resolve()
        .then(() => {
          if (job.version !== generation)
            throw new Error('Conversation changed.');
          if (!api?.conversationImage)
            throw new Error('Image loading is unavailable.');
          return api.conversationImage(job.id, job.variant);
        })
        .then(job.resolve, job.reject)
        .finally(() => {
          active--;
          startQueued();
        });
    }
  }

  function fetchImage(id, variant, version) {
    return new Promise((resolve, reject) => {
      queue.push({id, variant, version, resolve, reject});
      startQueued();
    });
  }

  function load(id, variant) {
    const key = `${variant}:${id}`;
    if (cache.has(key)) {
      const value = cache.get(key);
      cache.delete(key);
      cache.set(key, value);
      return Promise.resolve(value);
    }
    if (pending.has(key)) return pending.get(key);
    const version = generation;
    const request = fetchImage(id, variant, version)
      .then(value => {
        if (
          !value ||
          typeof value.src !== 'string' ||
          !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value.src) ||
          value.src.length > 24 * 1024 * 1024 ||
          !Number.isFinite(value.width) ||
          value.width <= 0 ||
          !Number.isFinite(value.height) ||
          value.height <= 0
        ) {
          throw new Error('The image response is invalid.');
        }
        if (version === generation) {
          cache.set(key, value);
          cacheSize += value.src.length;
          while (cache.size > 24 || cacheSize > 24 * 1024 * 1024) {
            const oldest = cache.keys().next().value;
            cacheSize -= cache.get(oldest).src.length;
            cache.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => {
        if (pending.get(key) === request) pending.delete(key);
      });
    pending.set(key, request);
    return request;
  }

  function evict(key) {
    if (!cache.has(key)) return;
    cacheSize -= cache.get(key).src.length;
    cache.delete(key);
  }

  function close() {
    viewerVersion++;
    viewerEntry = undefined;
    image.removeAttribute('src');
    if (dialog.open) dialog.close();
    if (previousFocus?.isConnected) previousFocus.focus({preventScroll: true});
    previousFocus = undefined;
  }
  async function loadViewer() {
    const entry = viewerEntry;
    if (!entry) return;
    const version = ++viewerVersion;
    image.hidden = true;
    image.removeAttribute('src');
    status.textContent = 'Loading image…';
    retry.hidden = true;
    try {
      const value = await load(entry.block.id, 'full');
      if (version !== viewerVersion || !dialog.open) return;
      image.src = value.src;
      await image.decode();
      if (version !== viewerVersion || !dialog.open) return;
      image.hidden = false;
      status.textContent = '';
      metadata.textContent = [
        `${entry.block.width || value.width} × ${entry.block.height || value.height}`,
        entry.block.path,
      ]
        .filter(Boolean)
        .join(' · ');
    } catch (error) {
      if (version !== viewerVersion || !dialog.open) return;
      evict(`full:${entry.block.id}`);
      status.textContent = error.message || 'Could not load image.';
      retry.hidden = false;
    }
  }
  function open(entry) {
    viewerEntry = entry;
    previousFocus = document.activeElement;
    title.textContent = entry.block.name || 'VarisDev image';
    image.alt = entry.block.name || 'VarisDev image';
    metadata.textContent = entry.block.path || '';
    if (!dialog.open) dialog.showModal();
    void loadViewer();
  }
  const onKey = event => {
    if (!dialog.open || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    close();
  };
  const onCancel = event => {
    event.preventDefault();
    close();
  };
  window.addEventListener('keydown', onKey, true);
  dialog.addEventListener('cancel', onCancel);
  closeButton.addEventListener('click', close);
  retry.addEventListener('click', loadViewer);

  function imageBlock(block) {
    const element = node('figure', 'visualization-image');
    const button = node('button', 'visualization-image-open');
    button.type = 'button';
    button.setAttribute('aria-label', `Open ${block.name || 'VarisDev image'}`);
    const thumbnail = node('img');
    thumbnail.alt = block.name || 'VarisDev image';
    thumbnail.decoding = 'async';
    thumbnail.hidden = true;
    if (block.width > 0 && block.height > 0) {
      thumbnail.width = Math.min(640, block.width);
      thumbnail.height = Math.max(
        1,
        Math.round((thumbnail.width * block.height) / block.width),
      );
    }
    const caption = node('figcaption', '', block.name || 'VarisDev image');
    const message = node('span', 'visualization-image-status', 'Image preview');
    message.setAttribute('role', 'status');
    const again = node('button', 'visualization-image-retry', 'Retry image');
    again.type = 'button';
    again.hidden = true;
    button.append(thumbnail, message);
    element.append(button, caption, again);
    let disposed = false;
    let loading = false;
    const entry = {
      element,
      block,
      update(next) {
        entry.block = next;
        const name = next.label || next.name || 'VarisDev image';
        button.setAttribute('aria-label', `Open ${name}`);
        thumbnail.alt = name;
        caption.textContent = name;
      },
      dispose() {
        disposed = true;
        observer.unobserve(element);
        element.loadImage = undefined;
        thumbnail.removeAttribute('src');
        if (viewerEntry === entry) close();
      },
    };
    element.loadImage = async () => {
      if (disposed || loading) return;
      loading = true;
      again.hidden = true;
      message.hidden = false;
      message.textContent = 'Loading image…';
      try {
        const value = await load(block.id, 'thumbnail');
        if (disposed) return;
        thumbnail.src = value.src;
        await thumbnail.decode();
        if (disposed) return;
        thumbnail.hidden = false;
        message.hidden = true;
      } catch (error) {
        if (disposed) return;
        evict(`thumbnail:${block.id}`);
        message.textContent = error.message || 'Could not load image.';
        again.hidden = false;
      } finally {
        loading = false;
      }
    };
    button.addEventListener('click', () => open(entry));
    again.addEventListener('click', () => void element.loadImage());
    observer.observe(element);
    return entry;
  }

  function create() {
    const element = node('div', 'conversation-visualizations');
    const blocks = new Map();
    const warnings = node('div', 'visualization-errors');
    warnings.setAttribute('role', 'status');
    const entry = {
      element,
      update(message) {
        const values = message.visualizations || [];
        const keys = new Set();
        values.forEach((block, index) => {
          const key =
            block.type === 'image'
              ? `image:${index}:${block.id}`
              : `${block.type}:${index}`;
          keys.add(key);
          let item = blocks.get(key);
          if (!item) {
            item =
              block.type === 'image'
                ? imageBlock(block)
                : {
                    element: node('div', `visualization-${block.type}`),
                    dispose() {},
                  };
            blocks.set(key, item);
          }
          const signature = JSON.stringify(block);
          if (item.signature !== signature) {
            if (block.type === 'image') item.update(block);
            else if (block.type === 'markdown')
              renderMarkdown(item.element, String(block.text || ''), true);
            else if (block.type === 'progress') {
              const progress = node('progress');
              const value = Number.isFinite(block.value)
                ? Math.max(0, block.value)
                : 0;
              const determinate =
                Number.isFinite(block.total) && block.total > 0;
              if (determinate) {
                progress.max = block.total;
                progress.value = Math.min(value, block.total);
              }
              const label = block.label || 'Progress';
              progress.setAttribute('aria-label', label);
              item.element.replaceChildren(
                node('span', '', label),
                progress,
                node(
                  'span',
                  '',
                  determinate
                    ? `${Math.min(value, block.total)} / ${block.total}`
                    : String(value),
                ),
              );
            }
            item.signature = signature;
          }
          if (element.children[index] !== item.element)
            element.insertBefore(item.element, element.children[index] || null);
        });
        for (const [key, item] of blocks) {
          if (keys.has(key)) continue;
          item.dispose();
          item.element.remove();
          blocks.delete(key);
        }
        const errors = (message.visualizationErrors || []).join('\n');
        if (warnings.textContent !== errors) warnings.textContent = errors;
        warnings.hidden = !errors;
        element.append(warnings);
        element.hidden = !values.length && !errors;
      },
      dispose() {
        for (const item of blocks.values()) item.dispose();
        blocks.clear();
        entries.delete(entry);
      },
    };
    entries.add(entry);
    return entry;
  }
  function reset() {
    generation++;
    for (const job of queue.splice(0))
      job.reject(new Error('Conversation changed.'));
    close();
    for (const entry of [...entries]) entry.dispose();
    cache.clear();
    pending.clear();
    cacheSize = 0;
  }
  return {
    create,
    reset,
    dispose() {
      reset();
      observer.disconnect();
      window.removeEventListener('keydown', onKey, true);
      dialog.removeEventListener('cancel', onCancel);
      closeButton.removeEventListener('click', close);
      retry.removeEventListener('click', loadViewer);
    },
  };
}
