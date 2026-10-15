import type {AnyModel, Provider} from '@earendil-works/pi-ai';
import {
  ModelRuntime,
  type CreateAgentSessionOptions,
  type ExtensionContext,
  type LoadExtensionsResult,
} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';

const VIRTUAL_MODEL_API = 'pi-virtual';

function isVirtualModel(model: AnyModel): boolean {
  return model.api === VIRTUAL_MODEL_API;
}

/**
 * Register virtual models early enough for initial model selection.
 *
 * Pi normally drains this queue when it binds a session. VarisDev resolves the
 * startup model before then, so its parent and worker setup call this helper
 * immediately after creating their ModelRuntime instead.
 */
export function flushPendingVirtualModelRegistrations(
  extensionRuntime: LoadExtensionsResult['runtime'],
  modelRuntime: Pick<ModelRuntime, 'registerVirtualModel'>,
): void {
  for (const {definition} of extensionRuntime.pendingVirtualModelRegistrations)
    modelRuntime.registerVirtualModel(definition);
  extensionRuntime.pendingVirtualModelRegistrations = [];
}

function providerIds(
  modelRegistry: ExtensionContext['modelRegistry'],
): Set<string> {
  const models: AnyModel[] = [
    ...modelRegistry.getAll(),
    ...modelRegistry.getModelsOfType('classifier'),
    ...modelRegistry.getModelsOfType('image'),
  ];
  return new Set(
    models.filter(model => !isVirtualModel(model)).map(model => model.provider),
  );
}

/** Share one parent catalog and resolve its native credentials per request. */
function bridgeProvider(
  provider: Provider,
  modelRegistry: ExtensionContext['modelRegistry'],
): Provider {
  const authProbe = provider.getModels()[0];
  let credentialType: 'api_key' | 'oauth' =
    provider.auth.oauth && !provider.auth.apiKey ? 'oauth' : 'api_key';
  if (authProbe && modelRegistry.isUsingOAuth(authProbe))
    credentialType = 'oauth';
  return {
    ...provider,
    // Routers are session-local registrations. Never let their catalog metadata
    // masquerade as a physical model in a runtime without that registration.
    getModels: () =>
      provider.getModels().filter(model => !isVirtualModel(model)),
    getAllModels: () =>
      (provider.getAllModels?.() ?? provider.getModels()).filter(
        model => !isVirtualModel(model),
      ),
    // The parent owns catalog refreshes and credential storage. Forward model
    // requests through its registry so model-specific headers/base URLs are
    // composed there. Optional deferred operations remain on the native view.
    refreshModels: undefined,
    auth: {
      apiKey: {
        name: 'Parent session',
        async check() {
          return {type: credentialType};
        },
        async resolve() {
          const result = await modelRegistry.getProviderAuth(provider.id);
          if (!result) {
            throw new Error(
              `Parent model provider is unavailable: ${provider.id}`,
            );
          }
          return result;
        },
      },
    },
    stream: (model, context, options) =>
      modelRegistry.stream(model, context, options as never),
    streamSimple: (model, context, options) =>
      modelRegistry.streamSimple(model, context, options),
    ...(provider.classify
      ? {
          classify: (model, context, options) =>
            modelRegistry.classify(model, context, options),
        }
      : {}),
    ...(provider.generateImages
      ? {
          generateImages: (model, context, options) =>
            modelRegistry.generateImages(model, context, options),
        }
      : {}),
  };
}

/** Install parent-authenticated views of every configured parent provider. */
export function registerParentModelProviders(
  modelRegistry: ExtensionContext['modelRegistry'],
  modelRuntime: Pick<ModelRuntime, 'registerNativeProvider'>,
): string[] {
  const registered: string[] = [];
  for (const providerId of providerIds(modelRegistry)) {
    if (!modelRegistry.getProviderAuthStatus(providerId).configured) continue;
    const provider = modelRegistry.getProvider(providerId);
    if (!provider) continue;
    modelRuntime.registerNativeProvider(
      bridgeProvider(provider, modelRegistry),
    );
    registered.push(providerId);
  }
  return registered;
}

/**
 * Create a worker-local runtime backed by every configured parent provider.
 *
 * Virtual definitions are registered separately from the worker's ResourceLoader
 * so their route callbacks receive the worker ExtensionContext. Parent-only
 * inline virtual factories must therefore also be supplied to the worker loader;
 * Pi does not expose registered route definitions through ModelRegistry.
 * Copying all configured physical catalogs lets routes cross providers.
 */
export async function createWorkerModelRuntime(
  modelRegistry: ExtensionContext['modelRegistry'],
  model: NonNullable<CreateAgentSessionOptions['model']>,
  directory: string,
): Promise<ModelRuntime> {
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  const registered = registerParentModelProviders(modelRegistry, modelRuntime);

  // A virtual selection is supplied only by the worker's extension queue. Its
  // provider may intentionally have no physical catalog to bridge.
  if (model.api !== VIRTUAL_MODEL_API && !registered.includes(model.provider)) {
    throw new Error(`Parent model provider is unavailable: ${model.provider}`);
  }

  // registerNativeProvider refreshes asynchronously. Establish a deterministic
  // local availability snapshot before createAgentSession validates/restores.
  if (registered.length > 0) {
    await modelRuntime.refresh({
      allowNetwork: false,
      providers: registered,
    });
  }
  return modelRuntime;
}
