import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test} from 'node:test';

void test('desktop account and tool settings services defer the SDK until requested', async t => {
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (/^@earendil-works\/pi-(ai|coding-agent|tui)(\/|$)/.test(specifier))
        throw new Error(`Desktop startup loaded ${specifier}`);
      return next(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const [{DesktopAccounts}, {DesktopToolSettings}] = await Promise.all([
    import('../src/desktop/accounts.ts'),
    import('../src/desktop/tool-settings.ts'),
  ]);
  let runtimeLoads = 0;
  const createRuntime = async () => {
    runtimeLoads++;
    throw new Error('The model runtime must wait for a settings request.');
  };
  const accounts = new DesktopAccounts({
    createRuntime,
    openBrowser: async () => assert.fail('Startup opened a browser.'),
    changed: () => assert.fail('Startup published account changes.'),
  });
  new DesktopToolSettings({
    createRuntime,
    sessionFeatures: async () => assert.fail('Startup requested a session.'),
  });
  assert.deepEqual(accounts.snapshot(), {
    revision: 0,
    providers: [],
    message: '',
    links: [],
  });
  accounts.cancel(undefined);
  await accounts.dispose();
  assert.equal(runtimeLoads, 0);
});
