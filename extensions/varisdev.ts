import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerCommitCommand} from '../src/commit.ts';
import {registerFactory} from '../src/dashboard/index.ts';
import {registerDesktopStartup} from '../src/desktop/startup.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import {registerProjectTools} from '../src/tools/index.ts';

export default function (pi: ExtensionAPI) {
  registerProjectTools(pi);
  const agents = registerAgentTools(pi);
  // Resource loaders run configured extensions before their inline factories.
  const releaseController = pi.events.on(
    'varisdev:dashboard-controller',
    request => {
      (request as {control?: typeof agents}).control = agents;
    },
  );
  registerFactory(pi, agents);
  registerCommitCommand(pi);
  registerDesktopStartup(pi);
  pi.on('session_shutdown', () => {
    releaseController();
  });
}
