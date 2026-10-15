import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AnyModel, Provider} from '@earendil-works/pi-ai';
import type {
  ExtensionContext,
  LoadExtensionsResult,
  ModelRuntime,
  VirtualModelDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  flushPendingVirtualModelRegistrations,
  registerParentModelProviders,
} from '../src/agents/model-runtime.ts';

function model(provider: string, id: string, api = 'openai-completions') {
  return {provider, id, api} as AnyModel;
}

function provider(id: string, models: AnyModel[]): Provider {
  return {
    id,
    name: id,
    auth: {} as Provider['auth'],
    getModels: () => models as ReturnType<Provider['getModels']>,
    getAllModels: () => models,
  } as unknown as Provider;
}

void test('worker provider bridge includes configured cross-provider route targets', () => {
  const virtual = model('router', 'auto', 'pi-virtual');
  const mixedVirtual = model('route-chat', 'auto', 'pi-virtual');
  const chat = model('route-chat', 'chat');
  const classifier = model(
    'route-classifier',
    'classifier',
    'typesafe-system-one',
  );
  const unavailable = model('not-configured', 'offline');
  const providers = new Map([
    ['router', provider('router', [virtual])],
    ['route-chat', provider('route-chat', [mixedVirtual, chat])],
    ['route-classifier', provider('route-classifier', [classifier])],
    ['not-configured', provider('not-configured', [unavailable])],
  ]);
  const registry = {
    getAll: () => [virtual, mixedVirtual, chat, unavailable],
    getModelsOfType: (type: string) =>
      type === 'classifier' ? [classifier] : [],
    getProviderAuthStatus: (id: string) => ({
      configured: id !== 'not-configured',
    }),
    isUsingOAuth: () => false,
    getProvider: (id: string) => providers.get(id),
  } as unknown as ExtensionContext['modelRegistry'];
  const registered: Provider[] = [];

  const ids = registerParentModelProviders(registry, {
    registerNativeProvider(value) {
      registered.push(value);
    },
  });

  assert.deepEqual(ids, ['route-chat', 'route-classifier']);
  assert.deepEqual(
    registered.map(value => value.id),
    ids,
  );
  assert.deepEqual(registered[0].getModels(), [chat]);
  assert.deepEqual(registered[0].getAllModels?.(), [chat]);
});

void test('pending virtual registrations flush before VarisDev model lookup', () => {
  const definition = {
    provider: 'router',
    id: 'auto',
    name: 'Auto',
    route() {
      throw new Error('Routing is outside this wiring test.');
    },
  } satisfies VirtualModelDefinition;
  const extensionRuntime = {
    pendingVirtualModelRegistrations: [
      {definition, extensionPath: '/extensions/router.ts'},
    ],
  } as unknown as LoadExtensionsResult['runtime'];
  const registered: VirtualModelDefinition[] = [];

  flushPendingVirtualModelRegistrations(extensionRuntime, {
    registerVirtualModel(value) {
      registered.push(value);
    },
  } as Pick<ModelRuntime, 'registerVirtualModel'>);

  assert.deepEqual(registered, [definition]);
  assert.deepEqual(extensionRuntime.pendingVirtualModelRegistrations, []);
});
