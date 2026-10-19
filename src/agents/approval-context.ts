import type {ExtensionContext} from '@earendil-works/pi-coding-agent';
import type {AgentApprovalScope} from './approvals.ts';

/** Match policy identity when opening management outside a model turn. */
export function sessionAgentApprovalScope(
  ctx: Pick<ExtensionContext, 'cwd' | 'sessionManager'>,
): AgentApprovalScope {
  const saved = ctx.sessionManager
    .getBranch?.()
    .findLast(
      entry =>
        entry.type === 'custom' &&
        entry.customType === 'varisdev.agent-profile',
    );
  const profile =
    saved?.type === 'custom'
      ? (saved.data as {id?: string} | undefined)
      : undefined;
  return {
    agentId: profile?.id ?? 'default',
    conversationId: ctx.sessionManager.getSessionId(),
    workspace: ctx.cwd,
  };
}
