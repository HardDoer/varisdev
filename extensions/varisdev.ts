import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerApprovalCommand} from '../src/agents/approval-ui.ts';
import {registerFactory} from '../src/dashboard/index.ts';
import {registerDesktopStartup} from '../src/desktop/startup.ts';
import {
  registerAgentTools,
  type AgentToolsOptions,
} from '../src/tools/agents.ts';
import {registerProjectTools} from '../src/tools/index.ts';

export default function (pi: ExtensionAPI) {
  registerProjectTools(pi);
  const agentTools: AgentToolsOptions = {};
  const agents = registerAgentTools(pi, undefined, agentTools);
  // Resource loaders run configured extensions before their inline factories.
  const releaseController = pi.events.on(
    'varisdev:dashboard-controller',
    request => {
      (request as {control?: typeof agents}).control = agents;
    },
  );
  registerFactory(pi, agents, undefined, agentTools);
  registerApprovalCommand(pi);
  registerDesktopStartup(pi);
  pi.on('session_shutdown', () => {
    releaseController();
  });
}
