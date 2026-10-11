/* eslint-disable no-control-regex -- Recognize terminal capability replies. */
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import {
  Container,
  getCapabilities,
  matchesKey,
  truncateToWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import {stat} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {
  ImagePreviewComponent,
  type PreviewRuntime,
} from './image-preview/component.ts';
import {readPreviewImage, resolveImagePath} from './image-preview/files.ts';
import {rewriteImageLinks} from './image-preview/markdown.ts';
import {SixelOutput} from './image-preview/sixel.ts';

const ENTRY_TYPE = 'varisdev.images';
type ImageEntry = {paths: string[]};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function imagePaths(
  toolName: string,
  details: unknown,
  input: unknown,
  cwd: string,
): string[] {
  const data = record(details);
  const candidates =
    (toolName === 'openai_image' || toolName === 'image_preview') &&
    Array.isArray(data.images)
      ? data.images.map(image => record(image).path)
      : toolName === 'download'
        ? [data.path]
        : toolName === 'read'
          ? [record(input).path]
          : [];
  return candidates.flatMap(value => {
    const path =
      typeof value === 'string' ? resolveImagePath(value, cwd) : undefined;
    return path ? [path] : [];
  });
}

/** Native previews owned entirely by this extension; no Pi package patches. */
export function registerImagePreviews(pi: ExtensionAPI): void {
  const runtime: PreviewRuntime = {
    sixel: false,
    active: false,
    invalidate: () => {},
  };
  const components = new Map<
    string,
    {container: Container; images: ImagePreviewComponent[]}
  >();
  const recent = new Set<string>();
  const shown = new Map<string, string>();
  let context: ExtensionContext | undefined;
  let generation = 0;
  let detachInput: (() => void) | undefined;
  let terminalUI: TUI | undefined;

  function stop(): void {
    generation++;
    runtime.active = false;
    runtime.sixel = false;
    runtime.invalidate = () => {};
    runtime.output?.dispose();
    runtime.output = undefined;
    detachInput?.();
    detachInput = undefined;
    terminalUI = undefined;
    context = undefined;
    for (const value of components.values())
      for (const image of value.images) image.dispose();
    components.clear();
    recent.clear();
    shown.clear();
  }

  function remember(path: string): void {
    recent.delete(path);
    recent.add(path);
  }

  async function show(
    paths: string[],
    index: number,
    ctx: ExtensionContext,
  ): Promise<void> {
    await ctx.ui.custom<void>(
      (tui, theme, _keys, done) => {
        let image: ImagePreviewComponent | undefined;
        let key = '';
        return {
          render(width: number): string[] {
            const nextKey = `${index}:${width}:${tui.terminal.rows}`;
            if (nextKey !== key) {
              image?.dispose();
              image = new ImagePreviewComponent(
                paths[index],
                theme,
                runtime,
                Math.max(1, tui.terminal.rows - 7),
                Math.max(1, width - 2),
              );
              key = nextKey;
            }
            return [
              truncateToWidth(
                theme.fg('accent', `Image ${index + 1}/${paths.length}`),
                width,
              ),
              truncateToWidth(
                theme.fg('muted', '←/→ previous/next · Esc close'),
                width,
              ),
              '',
              ...image!.render(width),
            ];
          },
          invalidate() {},
          handleInput(data: string) {
            if (
              matchesKey(data, 'escape') ||
              matchesKey(data, 'ctrl+c') ||
              data === 'q'
            )
              done();
            else if (matchesKey(data, 'left')) {
              index = (index + paths.length - 1) % paths.length;
              tui.requestRender();
            } else if (matchesKey(data, 'right')) {
              index = (index + 1) % paths.length;
              tui.requestRender();
            }
          },
          dispose() {
            image?.dispose();
          },
        };
      },
      {
        overlay: true,
        overlayOptions: {width: '100%', maxHeight: '100%', margin: 1},
      },
    );
  }

  function card(path: string, theme: Theme): ImagePreviewComponent {
    return new ImagePreviewComponent(path, theme, runtime, 18, 64, () => {
      const ctx = context;
      if (!ctx || !runtime.active) return;
      void show([path], 0, ctx).catch(error => {
        if (runtime.active && context === ctx)
          ctx.ui.notify(String(error), 'error');
      });
    });
  }

  pi.registerEntryRenderer<ImageEntry>(
    ENTRY_TYPE,
    (entry, _options, theme): Component | undefined => {
      const paths = entry.data?.paths;
      if (!Array.isArray(paths)) return undefined;
      let cached = components.get(entry.id);
      if (!cached) {
        const container = new Container();
        const images = paths
          .filter(path => typeof path === 'string')
          .map(path => card(path, theme));
        for (const image of images) container.addChild(image);
        cached = {container, images};
        components.set(entry.id, cached);
      }
      return cached.container;
    },
  );

  pi.on('session_start', (_event, ctx) => {
    stop();
    if (ctx.mode !== 'tui') return;
    context = ctx;
    runtime.active = true;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === ENTRY_TYPE) {
        const paths = record(entry.data).paths;
        if (Array.isArray(paths))
          for (const path of paths)
            if (typeof path === 'string') remember(path);
      } else if (
        entry.type === 'message' &&
        entry.message.role === 'toolResult' &&
        !entry.message.isError
      ) {
        for (const path of imagePaths(
          entry.message.toolName,
          entry.message.details,
          {},
          ctx.cwd,
        ))
          remember(path);
      }
    }
    // The widget factory supplies the public TUI/Terminal handles. It occupies
    // no rows; images themselves live in custom transcript entries.
    ctx.ui.setWidget('varisdev-image-renderer', tui => {
      if (terminalUI === tui) return {render: () => [], invalidate() {}};
      runtime.output?.dispose();
      detachInput?.();
      terminalUI = tui;
      runtime.invalidate = () => tui.requestRender();
      if (
        !getCapabilities().images &&
        (process.env.WT_SESSION || process.platform === 'win32')
      ) {
        runtime.output = new SixelOutput(tui.terminal);
        // DECRQM identifies support and the original DECSDM setting without
        // turning on mouse reporting or changing terminal modes permanently.
        detachInput = tui.addInputListener(data => {
          const cleaned = data.replace(
            /\x1b\[\?80;([0-4])\$y/g,
            (_match, value: string) => {
              runtime.sixel = value === '1' || value === '2' || value === '4';
              if (runtime.output) runtime.output.displayModeSet = value === '1';
              tui.requestRender(true);
              return '';
            },
          );
          return cleaned === data ? undefined : {data: cleaned};
        });
        tui.terminal.write('\x1b[?80$p');
      }
      return {render: () => [], invalidate() {}};
    });
  });
  pi.on('session_shutdown', stop);

  async function present(paths: string[], force = false): Promise<void> {
    const current = generation;
    const ready: string[] = [];
    for (const path of paths.slice(0, 8)) {
      try {
        const info = await stat(path);
        if (!runtime.active || current !== generation) return;
        if (!info.isFile()) continue;
        remember(path);
        const signature = `${info.size}:${info.mtimeMs}`;
        if (force || shown.get(path) !== signature) {
          shown.set(path, signature);
          ready.push(path);
        }
      } catch {
        /* Stale or invented links stay as links, without broken cards. */
      }
    }
    if (ready.length && runtime.active && current === generation)
      pi.appendEntry(ENTRY_TYPE, {paths: ready});
  }

  pi.on('tool_result', async (event, ctx) => {
    if (!runtime.active || event.isError) return;
    const paths = imagePaths(
      event.toolName,
      event.details,
      event.input,
      ctx.cwd,
    );
    if (event.toolName === 'read' && getCapabilities().images) {
      for (const path of paths) remember(path);
      return;
    }
    await present(paths, event.toolName === 'image_preview');
  });
  pi.on('message_end', async (event, ctx) => {
    if (!runtime.active || event.message.role !== 'assistant') return;
    const paths = new Set<string>();
    for (const block of event.message.content)
      if (block.type === 'text') {
        rewriteImageLinks(block.text, ctx.cwd, path => {
          paths.add(path);
          return pathToFileURL(path).href;
        });
      }
    await present([...paths]);
  });
  pi.registerMarkdownTransformer((markdown, options) => {
    if (!context || options.messageType === 'assistant-thinking')
      return markdown;
    return rewriteImageLinks(
      markdown,
      context.cwd,
      path => pathToFileURL(path).href,
    );
  });
  pi.registerCommand('images', {
    description:
      'Preview the latest image in the terminal. Use /images <path> or /images list.',
    handler: async (args, ctx) => {
      if (!runtime.active) {
        ctx.ui.notify(
          'Image previews require an interactive terminal session.',
          'error',
        );
        return;
      }
      try {
        let paths = [...recent];
        let index = paths.length - 1;
        const argument = args.trim();
        if (argument === 'list') {
          if (!paths.length) {
            ctx.ui.notify(
              'No images in this session yet. Use /images <path>.',
              'info',
            );
            return;
          }
          const selected = await ctx.ui.select('Images', [...paths].reverse());
          if (!selected) return;
          index = paths.indexOf(selected);
        } else if (argument) {
          const path = resolveImagePath(argument, ctx.cwd);
          if (!path)
            throw new Error(
              'Use a local PNG, JPEG, GIF, WebP, AVIF, SVG, or TIFF path.',
            );
          await readPreviewImage(path);
          remember(path);
          paths = [...recent];
          index = paths.indexOf(path);
        }
        if (!paths.length) {
          ctx.ui.notify(
            'No images in this session yet. Use /images <path>.',
            'info',
          );
          return;
        }
        await show(paths, index, ctx);
      } catch (error) {
        if (runtime.active)
          ctx.ui.notify(`Could not preview image: ${String(error)}`, 'error');
      }
    },
  });
}
