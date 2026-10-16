import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from '@earendil-works/pi-coding-agent';
import {Text} from '@earendil-works/pi-tui';
import {
  LLAMA_PROVIDER,
  llamaModules,
  type LlamaClient,
  type LlamaModel,
  type LlamaProgress,
} from '../llama.ts';

const loaded = (model: LlamaModel) =>
  ['loaded', 'sleeping'].includes(model.status.value);

/** Desktop controls for Pi's official llama.cpp provider, router and Hugging Face clients. */
export function createLlamaExtension() {
  let active: AbortController | undefined;

  async function progress<T>(
    ctx: ExtensionCommandContext,
    signal: AbortSignal,
    title: string,
    model: string,
    run: (
      signal: AbortSignal,
      update: (value: LlamaProgress) => void,
    ) => Promise<T>,
    cancel: () => Promise<void>,
  ): Promise<{value: T} | undefined> {
    const controller = new AbortController();
    const operationSignal = AbortSignal.any([signal, controller.signal]);
    let operation: Promise<{value: T} | {error: unknown}> | undefined;
    let settled = false;
    let succeeded = false;
    let cancelled = false;
    try {
      const result = await ctx.ui.custom<
        {value: T} | {error: unknown} | undefined
      >((tui, _theme, keys, done) => {
        let status: LlamaProgress = {message: 'Starting…'};
        const abort = () => done(undefined);
        operationSignal.addEventListener('abort', abort, {once: true});
        operation = Promise.resolve()
          .then(() => {
            operationSignal.throwIfAborted();
            return run(operationSignal, value => {
              status = value;
              tui.requestRender();
            });
          })
          .then(
            value => ({value}),
            error => ({error}),
          )
          .then(outcome => {
            settled = true;
            succeeded = 'value' in outcome;
            done(outcome);
            return outcome;
          });
        return {
          render(width) {
            const percent =
              status.ratio === undefined
                ? ''
                : ` ${Math.round(status.ratio * 100)}%`;
            return new Text(
              `${title}\n${model}\n\n${status.message}${percent}\n${status.detail || ''}\n\nPress Escape or Cancel to stop.`,
              1,
              1,
            ).render(width);
          },
          handleInput(data) {
            if (keys.matches(data, 'tui.select.cancel')) done(undefined);
          },
          invalidate() {},
          dispose() {
            operationSignal.removeEventListener('abort', abort);
          },
        };
      });
      cancelled = result === undefined;
      signal.throwIfAborted();
      if (result && 'error' in result) throw result.error;
      return result;
    } finally {
      const interrupted = signal.aborted || cancelled || !settled;
      controller.abort();
      if (operation && interrupted && !succeeded) {
        const [, cancellation] = await Promise.allSettled([
          operation,
          cancel(),
        ]);
        if (cancellation.status === 'rejected')
          ctx.ui.notify(
            `Could not stop ${model}: ${String(cancellation.reason)}`,
            'error',
          );
      }
    }
  }

  async function download(
    ctx: ExtensionCommandContext,
    client: LlamaClient,
    signal: AbortSignal,
  ) {
    const query = (
      await ctx.ui.input(
        'Download a GGUF model',
        'Search Hugging Face or enter owner/repository[:quantization]',
        {signal},
      )
    )?.trim();
    if (!query) return;
    const {HuggingFaceClient, findHuggingFaceToken, formatBytes} =
      await llamaModules();
    const huggingFace = new HuggingFaceClient(await findHuggingFaceToken());
    signal.throwIfAborted();
    let repository = query;
    let quantization: string | undefined;
    if (query.includes('/')) {
      const colon = query.indexOf(':', query.indexOf('/') + 1);
      if (colon >= 0) {
        repository = query.slice(0, colon);
        quantization = query.slice(colon + 1) || undefined;
      }
    } else {
      const models = await huggingFace.search(query, signal);
      if (!models.length) {
        ctx.ui.notify(
          'No GGUF repositories found. Try another search.',
          'info',
        );
        return;
      }
      const selected = await ctx.ui.select(
        'Choose a repository',
        models.map(model => model.id),
        {signal},
      );
      if (!selected) return;
      repository = selected;
    }
    const details = await huggingFace.details(repository, signal);
    if (details.gated) {
      const approved = await ctx.ui.confirm(
        'Hugging Face access required',
        `Accept access terms at https://huggingface.co/${details.id}. The llama.cpp server needs HF_TOKEN with access. Continue?`,
        {signal},
      );
      if (!approved) return;
    }
    if (!quantization && details.quantizations.length) {
      const options = details.quantizations.map(
        item =>
          item.name +
          (item.size === undefined ? '' : ` · ${formatBytes(item.size)}`),
      );
      const selected = await ctx.ui.select(
        `Quantization for ${details.id}`,
        options,
        {signal},
      );
      if (!selected) return;
      quantization = details.quantizations[options.indexOf(selected)].name;
    }
    const model = quantization ? `${details.id}:${quantization}` : details.id;
    const result = await progress(
      ctx,
      signal,
      'Downloading model',
      model,
      (signal, update) => client.downloadAndWait(model, update, signal),
      () => client.unload(model, AbortSignal.timeout(5000)),
    );
    if (result) ctx.ui.notify(`Downloaded ${model}`, 'info');
  }

  async function load(
    ctx: ExtensionCommandContext,
    client: LlamaClient,
    catalog: LlamaModel[],
    model: LlamaModel,
    signal: AbortSignal,
  ) {
    const others = catalog.filter(item => item.id !== model.id && loaded(item));
    let replace = false;
    if (others.length) {
      const choice = await ctx.ui.select(
        `${others.length} other model(s) loaded`,
        ['Keep loaded and load', 'Unload others and load', 'Cancel'],
        {signal},
      );
      if (!choice || choice === 'Cancel') return;
      replace = choice === 'Unload others and load';
    }
    const removed: LlamaModel[] = [];
    let completed = false;
    try {
      if (replace)
        for (const other of others) {
          await client.unloadAndWait(other.id, signal);
          removed.push(other);
        }
      const result = await progress(
        ctx,
        signal,
        'Loading model',
        model.id,
        (signal, update) => client.loadAndWait(model.id, update, signal),
        () => client.unload(model.id, AbortSignal.timeout(5000)),
      );
      completed = !!result;
      if (completed)
        ctx.ui.notify(`Loaded ${model.id}. Select it in Menu → Model.`, 'info');
    } finally {
      if (!completed && removed.length) {
        const restoreSignal = AbortSignal.timeout(60000);
        for (const other of removed)
          await client.loadAndWait(other.id, () => {}, restoreSignal);
      }
    }
  }

  async function manage(ctx: ExtensionCommandContext, signal: AbortSignal) {
    const auth = await ctx.modelRegistry.getProviderAuth(LLAMA_PROVIDER);
    signal.throwIfAborted();
    if (!auth) {
      ctx.ui.notify(
        'Connect llama.cpp in Menu → Accounts, then run /llama.',
        'warning',
      );
      return;
    }
    const {LlamaClient, normalizeLlamaServerUrl} = await llamaModules();
    const url = auth.env?.LLAMA_BASE_URL;
    const client = new LlamaClient(
      normalizeLlamaServerUrl(
        typeof url === 'string' && url ? url : auth.auth.baseUrl || '',
      ),
      auth.auth.apiKey,
    );
    while (!signal.aborted) {
      try {
        const catalog = await client.list({signal});
        await ctx.modelRegistry.refresh({
          providers: [LLAMA_PROVIDER],
          allowNetwork: true,
          signal,
        });
        signal.throwIfAborted();
        const labels = catalog.map(
          model =>
            `${model.id} · ${model.status.value}${model.status.failed ? ' (failed)' : ''}`,
        );
        const choice = await ctx.ui.select(
          `llama.cpp · ${client.serverUrl}`,
          [...labels, 'Download model…', 'Refresh', 'Close'],
          {signal},
        );
        if (!choice || choice === 'Close') return;
        if (choice === 'Refresh') continue;
        if (choice === 'Download model…') await download(ctx, client, signal);
        else {
          const model = catalog[labels.indexOf(choice)];
          if (!model) continue;
          if (loaded(model)) {
            if (await ctx.ui.confirm('Unload model?', model.id, {signal}))
              await client.unloadAndWait(model.id, signal);
          } else if (model.status.value === 'unloaded')
            await load(ctx, client, catalog, model, signal);
          else ctx.ui.notify(`${model.id} is ${model.status.value}`, 'info');
        }
      } catch (error) {
        if (signal.aborted) return;
        const choice = await ctx.ui.select(
          `llama.cpp: ${error instanceof Error ? error.message : String(error)}`,
          ['Retry', 'Close'],
          {signal},
        );
        if (choice !== 'Retry') return;
      }
    }
  }

  return {
    cancel() {
      active?.abort();
    },
    async extension(pi: ExtensionAPI) {
      const {createLlamaProvider} = await llamaModules();
      pi.registerProvider(createLlamaProvider().provider);
      pi.registerCommand('llama', {
        description: 'Download, load and unload llama.cpp router models.',
        async handler(args, ctx) {
          if (args.trim()) {
            ctx.ui.notify('Usage: /llama', 'warning');
            return;
          }
          if (!ctx.hasUI)
            throw new Error('/llama requires the desktop interface.');
          if (active) throw new Error('The llama.cpp manager is already open.');
          const controller = new AbortController();
          active = controller;
          try {
            await manage(ctx, controller.signal);
          } finally {
            if (active === controller) active = undefined;
          }
        },
      });
      pi.on('session_shutdown', () => {
        active?.abort();
      });
    },
  };
}
