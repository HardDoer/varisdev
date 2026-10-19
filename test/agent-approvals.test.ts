import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import {
  AgentApprovalStore,
  canonicalApprovalWorkspace,
  type AgentApprovalDecision,
  type AgentApprovalOperation,
  type AgentApprovalScope,
} from '../src/agents/approvals.ts';
import {
  agentToolPermissions,
  checkAgentPermissions,
  type AgentApprovalRequest,
  type AgentPolicyOptions,
  type AgentPolicyProfile,
} from '../src/agents/policy.ts';

const operation: AgentApprovalOperation = {
  toolName: 'write',
  action: 'edit',
  resource: '/workspace/a.txt',
  input: {path: 'a.txt', content: 'approved content'},
};
const baseScope: AgentApprovalScope = {
  agentId: 'writer',
  conversationId: 'conversation-1',
  workspace: '/workspace',
};

async function fixture(t: {after: (fn: () => Promise<void>) => void}) {
  const directory = await mkdtemp(join(tmpdir(), 'varisdev-approvals-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return {directory, path: join(directory, 'approvals.json')};
}

function context(
  workspace: string,
  conversationId: string,
  signal?: AbortSignal,
) {
  return {
    cwd: workspace,
    hasUI: false,
    signal,
    sessionManager: {getSessionId: () => conversationId},
  } as unknown as ExtensionContext;
}
const profile: AgentPolicyProfile = {
  id: 'writer',
  permissions: [{action: 'edit', resource: '*', effect: 'ask'}],
};

async function check(
  store: AgentApprovalStore,
  workspace: string,
  approval: NonNullable<AgentPolicyOptions['approval']>,
  options: {
    profile?: AgentPolicyProfile;
    conversationId?: string;
    signal?: AbortSignal;
    input?: Record<string, unknown>;
    requests?: Parameters<typeof checkAgentPermissions>[3];
  } = {},
) {
  const input = options.input ?? {path: 'a.txt', content: 'approved content'};
  return checkAgentPermissions(
    options.profile ?? profile,
    'write',
    input,
    options.requests ?? agentToolPermissions('write', input, workspace),
    context(
      workspace,
      options.conversationId ?? 'conversation-1',
      options.signal,
    ),
    {approvals: store, approval},
  );
}

void test('conversation grants persist across store instances and isolate session, config ID, and canonical workspace', async t => {
  const {directory, path} = await fixture(t);
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const alias = join(directory, 'workspace-alias');
  await symlink(workspace, alias, 'dir');
  const scope = {...baseScope, workspace};
  const store = new AgentApprovalStore(path);
  const grant = await store.remember(scope, operation, 'conversation');
  assert.equal(grant.workspace, canonicalApprovalWorkspace(workspace));
  assert.equal(grant.conversationId, scope.conversationId);
  const resumed = new AgentApprovalStore(path);
  assert.equal(await resumed.allows(scope, operation), true);
  assert.equal(
    await resumed.allows({...scope, workspace: alias}, operation),
    true,
  );
  assert.equal(
    await resumed.allows(
      {...scope, conversationId: 'conversation-2'},
      operation,
    ),
    false,
  );
  assert.equal(
    await resumed.allows({...scope, agentId: 'other'}, operation),
    false,
  );
  assert.equal(
    await resumed.allows({...scope, workspace: directory}, operation),
    false,
  );
  assert.equal(
    await resumed.allows(scope, {...operation, resource: '/workspace/other'}),
    false,
  );
  assert.equal(
    await resumed.allows(scope, {...operation, toolName: 'edit'}),
    false,
  );
  assert.equal(
    await resumed.allows(scope, {...operation, action: 'read'}),
    false,
  );
  assert.equal(
    await resumed.allows(scope, {
      ...operation,
      input: {...operation.input, content: 'new'},
    }),
    false,
  );
  assert.equal(
    await resumed.allows(scope, {...operation, aliases: ['other resource']}),
    false,
  );
  assert.equal(
    await resumed.allows(scope, {
      ...operation,
      input: {content: 'approved content', path: 'a.txt'},
    }),
    true,
  );
});

void test('agent grants span conversations only for their config ID and workspace, with exact alias sets', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const scope = {...baseScope, workspace: directory};
  const aliased = {...operation, aliases: ['git status', 'git status --short']};
  await store.remember(scope, aliased, 'agent');
  assert.equal(
    await store.allows(
      {...scope, conversationId: 'other'},
      {...aliased, aliases: [...aliased.aliases].reverse()},
    ),
    true,
  );
  assert.equal(
    await store.allows(scope, {...aliased, aliases: ['git status']}),
    false,
  );
  assert.equal(
    await store.allows(scope, {
      ...aliased,
      aliases: [...aliased.aliases, 'git push'],
    }),
    false,
  );
  assert.equal(
    await store.allows({...scope, agentId: 'other'}, aliased),
    false,
  );
  assert.equal(
    await store.allows(
      {...scope, workspace: join(directory, 'other')},
      aliased,
    ),
    false,
  );
  assert.equal(
    (await store.list({workspace: directory, agentId: 'writer'}))[0]
      .conversationId,
    undefined,
  );
});

void test('revocation and scoped clearing are persistent and visible to existing store objects', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const otherProcess = new AgentApprovalStore(path);
  const scope = {...baseScope, workspace: directory};
  const first = await store.remember(scope, operation, 'conversation');
  const duplicate = await otherProcess.remember(
    scope,
    operation,
    'conversation',
  );
  assert.equal(duplicate.id, first.id);
  await store.remember(scope, operation, 'agent');
  await store.remember({...scope, agentId: 'other'}, operation, 'agent');
  assert.equal(await otherProcess.revoke(first.id), true);
  assert.equal(await otherProcess.revoke(first.id), false);
  assert.equal((await store.list()).length, 2);
  assert.equal(await store.clear({workspace: directory, agentId: 'writer'}), 1);
  assert.equal(await otherProcess.allows(scope, operation), false);
  assert.equal(
    await otherProcess.allows({...scope, agentId: 'other'}, operation),
    true,
  );
  assert.equal(await store.clear(), 1);
  assert.deepEqual(await otherProcess.list(), []);
  assert.deepEqual(await readdir(directory), ['approvals.json']);
});

void test('policy choices preserve booleans, require exact operation input, and resume by current session identity', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  let prompts = 0;
  const approval = async (
    request: AgentApprovalRequest,
  ): Promise<AgentApprovalDecision> => {
    prompts++;
    assert.equal(request.agentId, 'writer');
    assert.equal(request.conversationId, 'conversation-1');
    assert.equal(request.workspace, canonicalApprovalWorkspace(directory));
    assert.deepEqual(request.choices, [
      'once',
      'conversation',
      'agent',
      'deny',
    ]);
    return 'conversation';
  };
  assert.equal(await check(store, directory, approval), undefined);
  assert.equal(
    await check(new AgentApprovalStore(path), directory, async () => {
      throw new Error('must use saved grant');
    }),
    undefined,
  );
  assert.equal(prompts, 1);
  assert.match(
    (await check(store, directory, async () => false, {
      conversationId: 'other',
    }))!.reason,
    /declined/,
  );
  assert.match(
    (await check(store, directory, async () => 'deny', {
      input: {path: 'a.txt', content: 'different'},
    }))!.reason,
    /declined/,
  );
  const another = {path: 'b.txt', content: 'once'};
  assert.equal(
    await check(store, directory, async () => true, {input: another}),
    undefined,
  );
  assert.match(
    (await check(store, directory, async () => false, {input: another}))!
      .reason,
    /declined/,
  );
  assert.equal(
    await check(store, directory, async () => 'once', {input: another}),
    undefined,
  );
  assert.equal((await store.list()).length, 1);
});

void test('effective denies across all requests preflight before grants and retain ordered rule exceptions', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const input = {path: 'a.txt', content: 'approved content'};
  const resource = agentToolPermissions('write', input, directory)[0].resource;
  await store.remember(
    {...baseScope, workspace: directory},
    {...operation, resource, input},
    'agent',
  );
  let prompts = 0;
  const approval = async () => {
    prompts++;
    return true;
  };
  assert.match(
    (await check(store, directory, approval, {
      profile: {
        id: 'writer',
        permissions: [{action: 'edit', resource: '*', effect: 'deny'}],
      },
    }))!.reason,
    /permission denied/,
  );
  assert.match(
    (await check(store, directory, approval, {
      profile: {
        id: 'writer',
        permissions: [
          {action: 'edit', resource: '*', effect: 'ask'},
          {action: 'read', resource: '*', effect: 'deny'},
        ],
      },
      requests: [
        {action: 'edit', resource},
        {action: 'read', resource: join(directory, 'secret')},
      ],
    }))!.reason,
    /permission denied/,
  );
  assert.equal(prompts, 0);
  assert.equal(
    await check(store, directory, approval, {
      profile: {
        id: 'writer',
        permissions: [
          {action: '*', resource: '*', effect: 'deny'},
          {action: 'edit', resource: 'a.txt', effect: 'ask'},
        ],
      },
    }),
    undefined,
  );
  assert.equal(prompts, 0);
  const grant = (await store.list())[0];
  await store.revoke(grant.id);
  assert.equal(await check(store, directory, approval), undefined);
  assert.equal(prompts, 1);
});

void test('cancelled prompts cannot apply late answers or persist remembered grants', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const controller = new AbortController();
  const entered = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<AgentApprovalDecision>();
  const result = check(
    store,
    directory,
    async request => {
      assert.equal(request.signal, controller.signal);
      entered.resolve();
      return answer.promise;
    },
    {signal: controller.signal},
  );
  await entered.promise;
  controller.abort(new Error('Stopped worker'));
  assert.match((await result)!.reason, /cancelled.*Stopped worker/);
  answer.resolve('agent');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await store.list(), []);
  const synchronous = new AbortController();
  assert.match(
    (await check(
      store,
      directory,
      async () => {
        synchronous.abort(new Error('No longer wanted'));
        return 'conversation';
      },
      {signal: synchronous.signal},
    ))!.reason,
    /cancelled/,
  );
  assert.deepEqual(await store.list(), []);
});

void test('cancellation at the remembered grant lookup boundary blocks execution', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const controller = new AbortController();
  t.mock.method(store, 'allows', async () => {
    queueMicrotask(() => controller.abort(new Error('Stopped during lookup')));
    return true;
  });
  assert.match(
    (await check(
      store,
      directory,
      async () => {
        throw new Error('Remembered operation must not prompt');
      },
      {signal: controller.signal},
    ))!.reason,
    /cancelled.*Stopped during lookup/,
  );
});

void test('prompt data mutation cannot expand the exact input or alias scope stored', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  assert.equal(
    await check(store, directory, async request => {
      (request.input as Record<string, unknown>).content = 'different';
      return 'agent';
    }),
    undefined,
  );
  const grant = (await store.list())[0];
  assert.equal(grant.operation.input.content, 'approved content');
});

async function holdWrite(
  t: TestContext,
  store: AgentApprovalStore,
  directory: string,
) {
  const entered = Promise.withResolvers<void>();
  const resumed = Promise.withResolvers<void>();
  const original = store.list.bind(store);
  const mocked = t.mock.method(store, 'list', async () => {
    entered.resolve();
    await resumed.promise;
    return original();
  });
  const pending = store.remember(
    {...baseScope, workspace: directory},
    operation,
    'agent',
  );
  await entered.promise;
  return {
    pending,
    resume() {
      mocked.mock.restore();
      resumed.resolve();
    },
  };
}

void test('cancellation while waiting for a live lock is bounded and does not disturb the holder', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const holder = await holdWrite(t, store, directory);
  const other = new AgentApprovalStore(path);
  const controller = new AbortController();
  try {
    const pending = other.remember(
      {...baseScope, workspace: directory},
      {...operation, resource: 'other'},
      'agent',
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('Cancelled waiting')), 50);
    await assert.rejects(pending, /Cancelled waiting|aborted/);
    assert.deepEqual(await other.list(), []);
    await access(`${path}.lock`);
  } finally {
    holder.resume();
    await holder.pending;
  }
  assert.equal((await other.list()).length, 1);
  await assert.rejects(access(`${path}.lock`), {code: 'ENOENT'});
});

void test('a live transaction has a bounded acquisition timeout and keeps ownership until released', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const holder = await holdWrite(t, store, directory);
  const other = new AgentApprovalStore(path);
  try {
    await assert.rejects(
      other.remember(
        {...baseScope, workspace: directory},
        {...operation, resource: 'other'},
        'agent',
      ),
      /Timed out waiting for remembered approval storage lock/,
    );
    assert.deepEqual(await other.list(), []);
    await access(`${path}.lock`);
  } finally {
    holder.resume();
    await holder.pending;
  }
  assert.equal((await other.list()).length, 1);
  await assert.rejects(access(`${path}.lock`), {code: 'ENOENT'});
});

void test('aborting during disk sync prevents an atomic commit and cleans up the temporary file and lock', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const controller = new AbortController();
  const probe = await open(join(directory, 'probe'), 'wx');
  const prototype = Object.getPrototypeOf(probe) as {sync(): Promise<void>};
  await probe.close();
  await rm(join(directory, 'probe'));
  t.mock.method(prototype, 'sync', async () => {
    controller.abort(new Error('Cancelled during write'));
  });
  await assert.rejects(
    store.remember(
      {...baseScope, workspace: directory},
      operation,
      'agent',
      controller.signal,
    ),
    /Cancelled during write/,
  );
  assert.deepEqual(await store.list(), []);
  assert.deepEqual(await readdir(directory), []);
});

void test('malformed storage fails closed and releases its transaction lock', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  await store.remember(
    {...baseScope, workspace: directory},
    operation,
    'agent',
  );
  assert.equal((await store.list()).length, 1);
  await writeFile(path, '{"version":1,"grants":[{"scope":"agent"}]}');
  assert.match(
    (await check(store, directory, async () => true))!.reason,
    /Invalid remembered approval grant/,
  );
  await assert.rejects(
    store.revoke('missing'),
    /Invalid remembered approval grant/,
  );
  assert.deepEqual(await readdir(directory), ['approvals.json']);
});

void test('concurrent processes preserve additions and revocations and recover a dead lock holder', async t => {
  const {directory, path} = await fixture(t);
  const store = new AgentApprovalStore(path);
  const scope = {...baseScope, workspace: directory};
  const revoked = await store.remember(scope, operation, 'conversation');
  const moduleURL = new URL('../src/agents/approvals.ts', import.meta.url).href;
  const script = `
    import {AgentApprovalStore} from ${JSON.stringify(moduleURL)};
    import {join} from 'node:path';
    const [path, worker, workspace, revoked] = process.argv.slice(1);
    const store = new AgentApprovalStore(path);
    process.send('ready');
    await new Promise(resolve => process.once('message', resolve));
    if (worker === 'crash') {
      setInterval(() => {}, 1000);
      store.list = async () => {
        process.send('locked');
        await new Promise(() => {});
      };
      void store.remember(
        {agentId:worker, conversationId:'conversation', workspace},
        {toolName:'write', action:'edit', resource:'crash', input:{}}, 'agent',
      );
      await new Promise(() => {});
    }
    for (let i = 0; i < 8; i++) {
      await store.remember(
        {agentId: worker, conversationId: 'conversation', workspace},
        {toolName:'write', action:'edit', resource:join(workspace, worker + '-' + i), input:{i,worker}},
        'agent',
      );
      if (i === 4) await store.revoke(revoked);
    }
    process.disconnect();
  `;
  function worker(id: string) {
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, path, id, directory, revoked.id],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    });
    let errors = '';
    child.stderr!.on('data', data => {
      errors += String(data);
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once('message', () => resolve());
      child.once('error', reject);
      child.once('exit', code => {
        if (code !== 0) reject(new Error(errors));
      });
    });
    const locked = new Promise<void>(resolve => {
      child.on('message', message => {
        if (message === 'locked') resolve();
      });
    });
    const done = new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 || (id === 'crash' && signal === 'SIGKILL')
          ? resolve()
          : reject(new Error(errors)),
      );
    });
    return {child, ready, done, locked};
  }
  const crashed = worker('crash');
  await crashed.ready;
  crashed.child.send('start');
  await crashed.locked;
  crashed.child.kill('SIGKILL');
  await crashed.done;
  const workers = ['one', 'two', 'three', 'four'].map(worker);
  await Promise.all(workers.map(item => item.ready));
  for (const item of workers) item.child.send('start');
  await Promise.all(workers.map(item => item.done));
  const grants = await store.list();
  assert.equal(grants.length, 32);
  assert.equal(
    grants.some(grant => grant.id === revoked.id),
    false,
  );
  for (const id of ['one', 'two', 'three', 'four']) {
    assert.equal(grants.filter(grant => grant.agentId === id).length, 8);
  }
  assert.deepEqual(await readdir(directory), ['approvals.json']);
  assert.equal(
    (JSON.parse(await readFile(path, 'utf8')) as {version: number}).version,
    1,
  );
});
