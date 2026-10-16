import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {AnyModel, Provider} from '@earendil-works/pi-ai';
import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import {registerParentModelProviders} from '../src/agents/model-runtime.ts';

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

void test('worker bridge preserves native subscription auth and delegates credential resolution', async () => {
  const chat = model('subscription', 'chat');
  const oauth = {
    name: 'Subscription',
    isSubscription: true,
  } as NonNullable<Provider['auth']['oauth']>;
  const native = {...provider('subscription', [chat]), auth: {oauth}};
  const auth = {auth: {apiKey: 'parent-runtime-key'}};
  let resolutions = 0;
  const registry = {
    getAll: () => [chat],
    getModelsOfType: () => [],
    getProviderAuthStatus: () => ({configured: true}),
    isUsingOAuth: () => true,
    getProvider: () => native,
    getProviderAuth: async (id: string) => {
      assert.equal(id, 'subscription');
      resolutions++;
      return auth;
    },
  } as unknown as ExtensionContext['modelRegistry'];
  let bridge: Provider | undefined;
  registerParentModelProviders(registry, {
    registerNativeProvider(value) {
      bridge = value;
    },
  });
  assert.equal(bridge!.auth.oauth, oauth);
  assert.equal(bridge!.auth.oauth!.isSubscription, true);
  const input = {signal: new AbortController().signal} as Parameters<
    NonNullable<Provider['auth']['apiKey']>['resolve']
  >[0];
  assert.deepEqual(await bridge!.auth.apiKey!.check!(input), {type: 'oauth'});
  assert.equal(await bridge!.auth.apiKey!.resolve(input), auth);
  assert.equal(resolutions, 1);
});
