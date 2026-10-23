import type {Model} from '@earendil-works/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';

export type SpeedMode = 'regular' | 'fast' | 'ultrafast';
const entryType = 'varisdev.speed-mode';
const fastBeta = 'fast-mode-2026-02-01';

// Official availability: platform.claude.com/docs/en/build-with-claude/fast-mode,
// developers.openai.com/api/docs/{pricing,guides/ultrafast-mode}, and
// learn.chatgpt.com/docs/agent-configuration/speed (ChatGPT sign-in).
const openaiFast = [
  'gpt-6-astra',
  'gpt-6.1-sol',
  'gpt-6-luna',
  'gpt-6-sol',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4',
  'gpt-5.4-mini',
  'gpt-5.3-codex',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5',
  'gpt-5-mini',
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'o3',
  'o4-mini',
];
const chatgptFast = openaiFast.slice(0, 7);
const openaiUltrafast = ['gpt-6-astra', 'gpt-6.1-sol'];
const anthropicFast = ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8'];

type SpeedContext = Pick<ExtensionContext, 'model'> & {
  modelRegistry: Pick<
    ExtensionContext['modelRegistry'],
    'isUsingOAuth' | 'getProviderAuth'
  >;
  sessionManager: Pick<ExtensionContext['sessionManager'], 'getBranch'>;
};

const liveOAuth = new WeakMap<
  SpeedContext['modelRegistry'],
  Map<string, boolean>
>();

/** Bridged workers resolve credentials in their parent, beyond their local catalog snapshot. */
export async function refreshSpeedModeAuth(ctx: SpeedContext): Promise<void> {
  if (
    !ctx.model ||
    !['openai', 'openai-codex', 'anthropic'].includes(ctx.model.provider)
  )
    return;
  const auth = await ctx.modelRegistry.getProviderAuth(ctx.model.provider);
  let providers = liveOAuth.get(ctx.modelRegistry);
  if (!providers) {
    providers = new Map();
    liveOAuth.set(ctx.modelRegistry, providers);
  }
  providers.set(ctx.model.provider, auth?.source === 'OAuth');
}

function usingOAuth(ctx: SpeedContext): boolean {
  return ctx.model
    ? (liveOAuth.get(ctx.modelRegistry)?.get(ctx.model.provider) ??
        ctx.modelRegistry.isUsingOAuth(ctx.model))
    : false;
}

function listedModel(id: string, list: readonly string[]): string | undefined {
  return list.find(
    name =>
      id === name ||
      (id.startsWith(`${name}-`) &&
        /^\d{4}-?\d{2}-?\d{2}$/.test(id.slice(name.length + 1))),
  );
}

/** Only direct providers and their documented APIs can opt into these modes. */
export function supportedSpeedModes(
  model: Model<string> | undefined,
  oauth = false,
): SpeedMode[] {
  if (!model) return ['regular'];
  if (
    model.provider === 'anthropic' &&
    model.api === 'anthropic-messages' &&
    /^https:\/\/api\.anthropic\.com\/?$/.test(model.baseUrl) &&
    listedModel(model.id, anthropicFast)
  )
    return ['regular', 'fast'];
  const directOpenai =
    model.provider === 'openai' &&
    (model.api === 'openai-responses' ||
      (!oauth && model.api === 'openai-completions')) &&
    model.baseUrl === 'https://api.openai.com/v1';
  const legacyChatgpt =
    model.provider === 'openai-codex' &&
    model.api === 'openai-codex-responses' &&
    model.baseUrl === 'https://chatgpt.com/backend-api';
  if (!directOpenai && !legacyChatgpt) return ['regular'];
  const fast = listedModel(
    model.id,
    oauth || legacyChatgpt ? chatgptFast : openaiFast,
  );
  if (!fast) return ['regular'];
  return model.api !== 'openai-completions' &&
    listedModel(model.id, openaiUltrafast)
    ? ['regular', 'fast', 'ultrafast']
    : ['regular', 'fast'];
}

export function sessionSpeedMode(ctx: SpeedContext): SpeedMode {
  const model = ctx.model;
  if (!model) return 'regular';
  const entry = ctx.sessionManager.getBranch().findLast(entry => {
    if (entry.type !== 'custom' || entry.customType !== entryType) return false;
    const data = entry.data as
      {provider?: unknown; model?: unknown} | undefined;
    return data?.provider === model.provider && data.model === model.id;
  });
  const mode =
    entry?.type === 'custom'
      ? (entry.data as {mode?: unknown} | undefined)?.mode
      : undefined;
  return (mode === 'fast' || mode === 'ultrafast') &&
    supportedSpeedModes(model, usingOAuth(ctx)).includes(mode)
    ? mode
    : 'regular';
}

export function speedModeFeatures(ctx: SpeedContext) {
  return {
    speedMode: sessionSpeedMode(ctx),
    speedModes: supportedSpeedModes(ctx.model, usingOAuth(ctx)),
  };
}

export async function runSpeedCommand(
  name: string,
  args: string,
  ctx: SpeedContext,
  append: (type: string, data: unknown) => void,
): Promise<SpeedMode | undefined> {
  if (name !== 'fast' && name !== 'ultrafast') return;
  await refreshSpeedModeAuth(ctx);
  const value = args.trim().toLowerCase();
  if (value && value !== 'on' && value !== 'off')
    throw new Error(`Usage: /${name} [on|off]`);
  const current = sessionSpeedMode(ctx);
  const mode =
    value === 'off' || (!value && current === name) ? 'regular' : name;
  if (mode !== 'regular' && !speedModeFeatures(ctx).speedModes.includes(mode))
    throw new Error(
      `/${name} is unavailable for ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'the current model'}.`,
    );
  if (ctx.model && mode !== current)
    append(entryType, {
      provider: ctx.model.provider,
      model: ctx.model.id,
      mode,
    });
  return mode;
}

export function registerSpeedModes(pi: ExtensionAPI): void {
  let request:
    | {model: ExtensionContext['model']; mode: SpeedMode; supported: boolean}
    | undefined;
  const publish = (ctx: ExtensionContext) => {
    const mode = sessionSpeedMode(ctx);
    ctx.ui.setStatus(
      'varisdev-speed',
      mode === 'regular' ? undefined : mode === 'fast' ? '↯' : '↯↯',
    );
    pi.events.emit('varisdev:speed-mode', {
      sessionId: ctx.sessionManager.getSessionId(),
      speedMode: mode,
    });
  };
  for (const name of ['fast', 'ultrafast'])
    pi.registerCommand(name, {
      description: `Toggle ${name} mode for the current model, or use /${name} on|off.`,
      handler: async (args, ctx) => {
        const mode = await runSpeedCommand(name, args, ctx, (type, data) =>
          pi.appendEntry(type, data),
        );
        publish(ctx);
        ctx.ui.notify(`Speed: ${mode}.`, 'info');
      },
    });
  pi.on('session_start', async (_event, ctx) => {
    request = undefined;
    await refreshSpeedModeAuth(ctx);
    publish(ctx);
  });
  const refresh = async (_event: unknown, ctx: ExtensionContext) => {
    await refreshSpeedModeAuth(ctx);
    publish(ctx);
  };
  pi.on('model_select', refresh);
  pi.on('session_tree', refresh);
  pi.on('turn_start', async (_event, ctx) => {
    await refreshSpeedModeAuth(ctx);
    publish(ctx);
    request = {
      model: ctx.model,
      mode: sessionSpeedMode(ctx),
      supported: speedModeFeatures(ctx).speedModes.includes('fast'),
    };
  });
  pi.on('agent_end', () => {
    request = undefined;
  });
  pi.on('before_provider_request', event => {
    const model = request?.model;
    const mode = request?.mode;
    if (
      !model ||
      !mode ||
      !request?.supported ||
      !event.payload ||
      typeof event.payload !== 'object'
    )
      return;
    const payload = event.payload as Record<string, unknown>;
    // A redirected request must not inherit the selected model's capabilities.
    if (payload.model !== model.id) return;
    if (model.provider === 'anthropic') {
      if (mode === 'regular') return;
      const beta = listedModel(model.id, anthropicFast) !== 'claude-opus-5-5';
      return {
        ...payload,
        speed: 'fast',
        ...(beta
          ? {
              betas: [
                ...new Set([
                  ...(Array.isArray(payload.betas) ? payload.betas : []),
                  fastBeta,
                ]),
              ],
            }
          : {}),
      };
    }
    return {...payload, service_tier: mode === 'regular' ? 'default' : mode};
  });
}
