export default function registerCatalog(pi) {
  pi.registerProvider('global-extension', {
    api: 'openai-completions',
    baseUrl: 'https://global-extension.invalid/v1',
    models: [
      {
        id: 'physical',
        name: 'Extension physical model',
        reasoning: true,
        input: ['text'],
        contextWindow: 32000,
        maxTokens: 1000,
        cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0},
      },
    ],
  });
  pi.registerVirtualModel({
    provider: 'global-extension-router',
    id: 'route',
    name: 'Extension virtual model',
    thinkingLevels: ['off', 'low', 'high'],
    route() {
      throw new Error('Catalog tests do not send model requests.');
    },
  });
}
