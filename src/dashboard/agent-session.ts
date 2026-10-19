import type {AgentOrchestrator} from '../agents/orchestrator.ts';
import {nativeCommand, parseSlashCommand} from './command-catalog.mjs';
import {
  agentSessionRequest,
  type AgentSessionRequest,
  type AgentSessionResult,
} from './hub.ts';

/** Dispatch only through the selected owner's manager. */
export async function runAgentSessionRequest(
  manager: AgentOrchestrator,
  input: AgentSessionRequest,
): Promise<AgentSessionResult> {
  const request = agentSessionRequest(input);
  manager.get(request.agentId);
  switch (request.action) {
    case 'prompt': {
      const command = parseSlashCommand(request.prompt);
      if (command && nativeCommand(command.name))
        await manager.command(request.agentId, request.prompt);
      else await manager.send(request.agentId, request.prompt);
      return;
    }
    case 'abort':
      return manager.abort(request.agentId);
    case 'features':
      return manager.features(request.agentId);
    case 'configure':
      await manager.configure(request.agentId, request.configuration);
      return;
    case 'command':
      await manager.command(request.agentId, request.command);
      return;
    case 'compact':
      return manager.compact(request.agentId, request.instructions);
    case 'reload':
      return manager.reload(request.agentId);
    case 'close':
      return manager.closeAgent(request.agentId);
  }
}
