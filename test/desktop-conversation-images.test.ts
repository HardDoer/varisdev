import assert from 'node:assert/strict';
import type {ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {setImmediate as tick} from 'node:timers/promises';
import {
  conversationImageRegistry,
  hasConversationImage,
} from '../src/conversation-images.ts';
import {DashboardState} from '../src/dashboard/state.ts';
import {
  ExternalSessionRequests,
  type FactoryRequest,
} from '../src/desktop/ipc.ts';
import {
  createFactoryBridge,
  type FactoryControl,
} from '../src/desktop/launcher.ts';
import {processImage} from '../src/sharp.ts';
import type {ConversationImageResponse} from '../src/visualizations.ts';

class Child extends EventEmitter {
  connected = true;
  sent: Array<Record<string, unknown>> = [];
  deliver?: (message: Record<string, unknown>) => void;
  send(
    message: Record<string, unknown>,
    callback?: (error: Error | null) => void,
  ) {
    this.sent.push(message);
    this.deliver?.(message);
    callback?.(null);
    return true;
  }
  disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }
}

function attachment(id = 'image-session') {
  const at = new Date().toISOString();
  return new DashboardState({
    id,
    name: id,
    cwd: process.cwd(),
    status: 'idle',
    activity: 'Ready',
    startedAt: at,
    updatedAt: at,
  });
}
const controls: FactoryControl = {
  prompt: async () => {},
  abort: async () => ({steering: [], followUp: []}),
  cancelAgent: async () => {},
  features: async () => ({
    commands: [],
    models: [],
    thinkingLevel: 'off',
    thinkingLevels: [],
    tools: [],
    diagnostics: [],
  }),
  configure: async () => {},
  compact: async () => {},
  reload: async () => {},
};

async function image() {
  const png = await processImage({
    input: Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20"><rect width="40" height="20" fill="#${randomUUID().slice(0, 6)}"/></svg>`,
    ),
    output: 'png',
    limitInputPixels: 40_000_000,
  });
  return conversationImageRegistry.registerInline(
    png.data.toString('base64'),
    'image/png',
  );
}

void test('attached image requests load source registry PNGs and reject invalid, stale and detached requests', async () => {
  const registered = await image();
  assert.equal(hasConversationImage(registered.id), true);
  assert.equal(hasConversationImage(`image-${randomUUID()}`), false);
  const child = new Child();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  const current = attachment();
  bridge.attach(current, controls);
  bridge.ready();
  const requests = new ExternalSessionRequests(
    async request => {
      child.emit('message', request);
    },
    () => child.connected,
  );
  child.deliver = reply => {
    requests.reply(reply);
  };
  const response = await requests.request<ConversationImageResponse>(
    'conversationImage',
    'image-session',
    {imageId: registered.id, variant: 'full'},
  );
  assert.equal(response.width, 40);
  assert.equal(response.height, 20);
  assert.equal(response.name, 'Attachment.png');
  assert.match(response.src, /^data:image\/png;base64,/);
  const decoded = await processImage({
    input: Buffer.from(response.src.split(',')[1], 'base64'),
    output: 'metadata',
    limitInputPixels: 40_000_000,
  });
  assert.equal(decoded.metadata.format, 'png');
  await assert.rejects(
    requests.request('conversationImage', 'image-session', {
      imageId: '/tmp/arbitrary.png',
      variant: 'full',
    }),
    /registered image ID/,
  );
  await assert.rejects(
    requests.request('conversationImage', 'image-session', {
      imageId: registered.id,
      variant: 'original',
    }),
    /Unknown.*variant/,
  );
  await assert.rejects(
    requests.request('conversationImage', 'previous-session', {
      imageId: registered.id,
    }),
    /no longer attached/,
  );
  await assert.rejects(
    requests.request('conversationImage', 'image-session', {
      imageId: `image-${randomUUID()}`,
    }),
    /no longer available/,
  );
  const loading = requests.request('conversationImage', 'image-session', {
    imageId: (await image()).id,
  });
  const rejected = assert.rejects(loading, /changed/);
  await tick();
  bridge.detach(current);
  await rejected;
  bridge.close();
});

void test('image requests reserve client capacity for abort and keep their timeout above decoder timeout', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const sent: FactoryRequest[] = [];
  const requests = new ExternalSessionRequests(
    async request => {
      sent.push(request);
    },
    () => true,
    20_000,
  );
  const loading = Array.from({length: 16}, () =>
    requests.request('conversationImage', 'image-session', {
      imageId: `image-${randomUUID()}`,
    }),
  );
  await assert.rejects(
    requests.request('conversationImage', 'image-session', {}),
    /Too many pending/,
  );
  const abort = requests.request('abort', 'image-session');
  assert.equal(sent.at(-1)?.action, 'abort');
  requests.reply({
    type: 'reply',
    id: sent.at(-1)!.id,
    ok: true,
    value: {steering: [], followUp: []},
  });
  assert.deepEqual(await abort, {steering: [], followUp: []});
  const rejected = loading.map(request =>
    assert.rejects(request, /did not answer/),
  );
  t.mock.timers.tick(64_999);
  await assert.rejects(
    requests.request('conversationImage', 'image-session', {}),
    /Too many pending/,
  );
  t.mock.timers.tick(1);
  await Promise.all(rejected);
  const retry = requests.request('conversationImage', 'image-session', {});
  const disconnected = assert.rejects(retry, /disconnected/);
  requests.disconnect();
  await disconnected;
});

void test('source bridge reserves control slots while image replies are waiting for decoding', async () => {
  const registered = await image();
  const child = new Child();
  const bridge = createFactoryBridge(child as unknown as ChildProcess);
  let aborts = 0;
  bridge.attach(attachment(), {
    ...controls,
    abort: async () => {
      aborts++;
      return {steering: [], followUp: []};
    },
  });
  bridge.ready();
  const completed = Promise.withResolvers<void>();
  let imageReplies = 0;
  child.deliver = reply => {
    if (reply.type === 'reply' && /^load-\d+$/.test(String(reply.id))) {
      assert.equal(reply.ok, true);
      if (++imageReplies === 16) completed.resolve();
    }
  };
  for (let index = 0; index < 16; index++)
    child.emit('message', {
      type: 'request',
      id: `load-${index}`,
      sessionId: 'image-session',
      action: 'conversationImage',
      input: {imageId: registered.id},
    });
  child.emit('message', {
    type: 'request',
    id: 'load-over-limit',
    sessionId: 'image-session',
    action: 'conversationImage',
    input: {imageId: registered.id},
  });
  assert.equal(child.sent.at(-1)?.ok, false);
  assert.match(String(child.sent.at(-1)?.error), /Too many pending/);
  child.emit('message', {
    type: 'request',
    id: 'abort-now',
    sessionId: 'image-session',
    action: 'abort',
  });
  await tick();
  assert.equal(aborts, 1);
  assert.ok(
    child.sent.some(reply => reply.id === 'abort-now' && reply.ok === true),
  );
  await completed.promise;
  bridge.close();
});
