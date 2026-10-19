import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {
  defaultAgentApprovalStore,
  type AgentApprovalChoice,
  type AgentApprovalGrant,
  type AgentApprovalScope,
  type AgentApprovalStore,
} from './approvals.ts';
import {sessionAgentApprovalScope} from './approval-context.ts';
import type {AgentApprovalRequest, AgentPolicyOptions} from './policy.ts';

const approvalChoices = new Map<string, AgentApprovalChoice>([
  ['Allow once', 'once'],
  ['Allow this conversation', 'conversation'],
  ['Allow this agent in this workspace', 'agent'],
  ['Deny', 'deny'],
]);

/** Pi owns selector rendering, search, keyboard input and cancellation. */
export async function requestAgentApproval(
  request: AgentApprovalRequest,
  ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>,
): Promise<AgentApprovalChoice> {
  if (!ctx.hasUI || request.signal?.aborted) return 'deny';
  const selected = await ctx.ui.select(
    [
      `Permission: ${request.agentId ?? 'agent'}`,
      `${request.toolName}: ${request.action} ${request.resource}`,
      ...(request.workspace ? [`Workspace: ${request.workspace}`] : []),
    ].join('\n'),
    [...approvalChoices]
      .filter(([, choice]) => request.choices.includes(choice))
      .map(([label]) => label),
    {signal: request.signal},
  );
  if (request.signal?.aborted) return 'deny';
  return approvalChoices.get(selected ?? '') ?? 'deny';
}

/** Delegated sessions use the originating UI while policy supplies their identity. */
export function createAgentApprovalRelay(
  ctx: Pick<ExtensionContext, 'hasUI' | 'ui'>,
  signal?: () => AbortSignal | undefined,
): AgentPolicyOptions['approval'] {
  return ctx.hasUI
    ? request => {
        const relay = signal?.();
        return requestAgentApproval(
          {
            ...request,
            signal:
              request.signal && relay
                ? AbortSignal.any([request.signal, relay])
                : (request.signal ?? relay),
          },
          ctx,
        );
      }
    : undefined;
}

function grantLabel(grant: AgentApprovalGrant, index: number): string {
  return `${index + 1}. ${grant.agentId}: ${grant.operation.toolName} — ${grant.operation.action} ${grant.operation.resource}`;
}

export interface AgentApprovalManagementOptions {
  scope?: AgentApprovalScope;
  store?: AgentApprovalStore;
  signal?: AbortSignal;
}

/** Review the exact saved operation before revoking its grant. */
export async function showAgentApprovals(
  ctx: Pick<
    ExtensionContext,
    'hasUI' | 'ui' | 'cwd' | 'sessionManager' | 'signal'
  >,
  options: AgentApprovalManagementOptions = {},
): Promise<void> {
  if (!ctx.hasUI) throw new Error('Approvals require an interactive Pi UI.');
  const scope = options.scope ?? sessionAgentApprovalScope(ctx);
  const store = options.store ?? defaultAgentApprovalStore();
  const signal =
    options.signal && ctx.signal
      ? AbortSignal.any([options.signal, ctx.signal])
      : (options.signal ?? ctx.signal);
  while (!signal?.aborted) {
    const category = await ctx.ui.select(
      'Remembered approvals',
      ['This conversation', 'This agent in this workspace'],
      {signal},
    );
    if (!category || signal?.aborted) return;
    const conversation = category === 'This conversation';
    while (!signal?.aborted) {
      const grants = (
        await store.list(
          conversation
            ? {workspace: scope.workspace, conversationId: scope.conversationId}
            : {workspace: scope.workspace, agentId: scope.agentId},
        )
      ).filter(
        grant => grant.scope === (conversation ? 'conversation' : 'agent'),
      );
      if (signal?.aborted) return;
      if (!grants.length) {
        ctx.ui.notify('No remembered approvals.', 'info');
        break;
      }
      const labels = grants.map(grantLabel);
      const selected = await ctx.ui.select(category, labels, {signal});
      if (!selected || signal?.aborted) break;
      const grant = grants[labels.indexOf(selected)];
      if (!grant) continue;
      const operation = grant.operation;
      const action = await ctx.ui.select(
        [
          `${grant.agentId}: ${operation.toolName}`,
          `${operation.action} ${operation.resource}`,
          `Workspace: ${grant.workspace}`,
          ...(grant.conversationId
            ? [`Conversation: ${grant.conversationId}`]
            : []),
          `Granted: ${grant.createdAt}`,
          `Input: ${JSON.stringify(operation.input)}`,
        ].join('\n'),
        ['Revoke approval', 'Back'],
        {signal},
      );
      if (signal?.aborted) return;
      if (action === 'Revoke approval') {
        try {
          await store.revoke(grant.id, signal);
        } catch (error) {
          if (signal?.aborted) return;
          throw error;
        }
        if (!signal?.aborted) ctx.ui.notify('Approval revoked.', 'info');
      }
    }
  }
}

export function registerApprovalCommand(pi: ExtensionAPI): void {
  const active = new Set<AbortController>();
  const cancel = () => {
    for (const controller of active) controller.abort();
    active.clear();
  };
  pi.on('session_before_switch', cancel);
  pi.on('session_shutdown', cancel);
  pi.registerCommand('approvals', {
    description:
      'Review and revoke remembered conversation and agent approvals.',
    handler: async (args, ctx) => {
      if (args.trim()) throw new Error('Usage: /approvals');
      const controller = new AbortController();
      active.add(controller);
      try {
        await showAgentApprovals(ctx, {signal: controller.signal});
      } finally {
        active.delete(controller);
      }
    },
  });
}
