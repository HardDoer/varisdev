import {
  parseFrontmatter,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {
  createDefaultAgentProfile,
  ensureAgentProfilePermissions,
  resolveAgentTemplate,
  type AgentTemplate,
} from './agents/templates.ts';
import {
  checkAgentPermissions,
  type AgentPolicyOptions,
} from './agents/policy.ts';
import {builtinCommitSkillPath} from './builtin-assets.ts';
import {assertAgentModelAllowed, readToolSettings} from './tools/settings.ts';

export function registerCommitCommand(
  pi: ExtensionAPI,
  sendUserMessage: (
    ...args: Parameters<ExtensionAPI['sendUserMessage']>
  ) => void | Promise<void> = (...args) => pi.sendUserMessage(...args),
  policyOptions: AgentPolicyOptions = {},
): void {
  pi.registerCommand('commit', {
    description:
      'Commit and push through the configured commit agent. /commit [instructions]',
    handler: async (args, ctx) => {
      const saved = ctx.sessionManager
        ?.getBranch?.()
        .findLast(
          entry =>
            entry.type === 'custom' &&
            entry.customType === 'varisdev.agent-profile',
        );
      const profile = await ensureAgentProfilePermissions(
        ctx.cwd,
        saved?.type === 'custom'
          ? (saved.data as AgentTemplate)
          : createDefaultAgentProfile(),
      );
      const blocked = await checkAgentPermissions(
        profile,
        '/commit',
        {name: 'commit'},
        [{action: 'skill', resource: 'commit'}],
        ctx,
        policyOptions,
      );
      if (blocked) throw new Error(blocked.reason);
      const template = await resolveAgentTemplate(ctx.cwd, 'commit');
      if (!template || template.disabled)
        throw new Error('The commit agent configuration is unavailable.');
      if (template.mode === 'primary')
        throw new Error(
          'The commit agent configuration must support subagent or all mode.',
        );
      const settings = await readToolSettings();
      // Existing Commit settings apply until a user supplies a standard config.
      const legacy = template.scope === 'builtin' ? settings.commit : undefined;
      const inheritedModel =
        ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
      const selectedModel = template.model ?? legacy?.model ?? inheritedModel;
      if (!selectedModel)
        throw new Error(
          'Choose a current agent model or set model in the commit agent configuration.',
        );
      const separator = selectedModel.indexOf('/');
      const model =
        selectedModel === inheritedModel
          ? ctx.model
          : ctx.modelRegistry.find(
              selectedModel.slice(0, separator),
              selectedModel.slice(separator + 1),
            );
      if (!model)
        throw new Error(
          `Commit model is unavailable: ${selectedModel}. Update the commit agent configuration or Menu → Tool models → Commit.`,
        );
      await assertAgentModelAllowed(selectedModel, settings, template.model);
      const thinkingLevel =
        template.thinkingLevel ??
        legacy?.thinkingLevel ??
        pi.getThinkingLevel();
      const supported = getSupportedThinkingLevels(model);
      if (!supported.some(level => level === thinkingLevel))
        throw new Error(
          `Commit thinking level ${thinkingLevel} is unsupported for ${selectedModel}. Supported levels: ${supported.join(', ')}. Update the commit agent configuration, Menu → Tool models → Commit, or the current agent thinking level.`,
        );
      const skillPath =
        pi
          .getCommands()
          .find(
            command =>
              command.name === 'skill:commit' && command.source === 'skill',
          )?.sourceInfo.path ?? builtinCommitSkillPath;
      const {body} = parseFrontmatter(await readFile(skillPath, 'utf8'));
      const instructions = args.trim();
      await sendUserMessage(
        [
          `<skill name="commit" location="${skillPath}">\nReferences are relative to ${dirname(skillPath)}.\n\n${body.trim()}\n</skill>`,
          'Commit and push.',
          'Use these exact agent_spawn configuration arguments: ' +
            JSON.stringify({
              template: template.key,
              model: selectedModel,
              thinkingLevel,
              autoCleanup: true,
            }),
          ...(instructions
            ? [
                `Additional user instructions (apply these to the task above):\n${instructions}`,
              ]
            : []),
        ].join('\n\n'),
        {deliverAs: 'steer'},
      );
    },
  });
}
