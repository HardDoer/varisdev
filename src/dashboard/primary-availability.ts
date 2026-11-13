export function isAvailablePrimary(agent: {
  agentMode?: string;
  resumable?: boolean;
  status?: string;
}): boolean {
  return (
    agent.agentMode !== 'subagent' &&
    agent.resumable !== false &&
    agent.status !== 'closed'
  );
}
