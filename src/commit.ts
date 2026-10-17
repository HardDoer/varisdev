import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import {assertAgentModelAllowed, readToolSettings} from './tools/settings.ts';

export function registerCommitCommand(pi: ExtensionAPI): void {
  pi.registerCommand('commit', {
    description:
      'Commit and push through a background agent. /commit [instructions]',
    handler: async (args, ctx) => {
      const settings = await readToolSettings();
      const selectedModel =
        settings.commit.model ??
        (ctx.model && `${ctx.model.provider}/${ctx.model.id}`);
      if (!selectedModel)
        throw new Error(
          'Choose a parent model or select a model in Menu → Tool models → Commit.',
        );
      const separator = selectedModel.indexOf('/');
      const model =
        settings.commit.model === null
          ? ctx.model
          : ctx.modelRegistry.find(
              selectedModel.slice(0, separator),
              selectedModel.slice(separator + 1),
            );
      if (!model)
        throw new Error(
          `Commit model is unavailable: ${selectedModel}. Choose a model in Menu → Tool models → Commit.`,
        );
      await assertAgentModelAllowed(selectedModel, settings);
      const thinkingLevel =
        settings.commit.thinkingLevel ?? pi.getThinkingLevel();
      const supported = getSupportedThinkingLevels(model);
      if (!supported.some(level => level === thinkingLevel))
        throw new Error(
          `Commit thinking level ${thinkingLevel} is unsupported for ${selectedModel}. Supported levels: ${supported.join(', ')}. Change Menu → Tool models → Commit or the parent thinking level.`,
        );
      const instructions = args.trim();
      pi.sendUserMessage(
        [
          'Commit and push.',
          'Delegate this task using agent_spawn with name="Commit and push" and autoCleanup=true. Use these exact agent_spawn arguments: ' +
            JSON.stringify({model: selectedModel, thinkingLevel}) +
            '. Use the current conversation to supply the intended changes, relevant user instructions, completed checks, and any requested commit message or push destination in the task. Coordinate with active workers before delegating so the commit agent receives a stable set of changes.',
          'Ask the worker to read applicable repository instructions, inspect the changes and Git state, run required checks, fix relevant failures, stage the intended changes, commit according to repository conventions, and push to the requested destination or configured upstream. It should preserve unrelated changes and existing history, keep commit hooks enabled, and report commit hashes, checks, push outcome, and any remaining changes or blockers. If the changes are already committed, it should check whether they need pushing.',
          'Collect the result with agent_status or agent_wait before reporting completion. The worker session is automatically disposed when the task finishes; its saved result and transcript paths are available through agent_status.',
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
