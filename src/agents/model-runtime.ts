import {
  ModelRuntime,
  type CreateAgentSessionOptions,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {join} from 'node:path';

/** Share the parent provider and resolve its credentials for each worker request. */
export async function createWorkerModelRuntime(
  modelRegistry: ExtensionContext['modelRegistry'],
  model: NonNullable<CreateAgentSessionOptions['model']>,
  directory: string,
): Promise<ModelRuntime> {
  const provider = modelRegistry.getProvider(model.provider);
  if (!provider) {
    throw new Error(`Parent model provider is unavailable: ${model.provider}`);
  }
  const modelRuntime = await ModelRuntime.create({
    authPath: join(directory, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider({
    ...provider,
    // The parent owns catalog refreshes and credential storage. Resolve auth for
    // each request there, including runtime keys, OAuth and model header config.
    refreshModels: undefined,
    auth: {
      ...provider.auth,
      apiKey: {
        name: 'Parent session',
        async check() {
          if (!modelRegistry.getProviderAuthStatus(provider.id).configured) {
            return undefined;
          }
          return {
            type: modelRegistry.isUsingOAuth(model) ? 'oauth' : 'api_key',
          };
        },
        async resolve() {
          const result = await modelRegistry.getApiKeyAndHeaders(model);
          if (!result.ok) throw new Error(result.error);
          return {
            auth: {
              apiKey: result.apiKey,
              headers: result.headers,
              baseUrl: result.baseUrl,
            },
            env: result.env,
          };
        },
      },
    },
  });
  return modelRuntime;
}
