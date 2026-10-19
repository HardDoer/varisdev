import type {AnyModel, Provider} from '@earendil-works/pi-ai';
import {
  type ModelRuntime,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';

const VIRTUAL_MODEL_API = 'pi-virtual';

function isVirtualModel(model: AnyModel): boolean {
  return model.api === VIRTUAL_MODEL_API;
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
      ...provider.auth,
      apiKey: {
        name: 'Current agent',
        async check() {
          return {type: credentialType};
        },
        async resolve() {
          const result = await modelRegistry.getProviderAuth(provider.id);
          if (!result) {
            throw new Error(
              `Current agent model provider is unavailable: ${provider.id}`,
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
