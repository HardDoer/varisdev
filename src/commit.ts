import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';

export function registerCommitCommand(pi: ExtensionAPI): void {
  pi.registerCommand('commit', {
    description:
      'Commit and push through a background agent. /commit [instructions]',
    handler: async args => {
      const instructions = args.trim();
      pi.sendUserMessage(
        [
          'Commit and push.',
          'Delegate this task using agent_spawn with name="Commit and push", model="openai-codex/gpt-5.5", thinkingLevel="xhigh", autoCleanup=true, and notify=true. Use the current conversation to supply the intended changes, relevant user instructions, completed checks, and any requested commit message or push destination in the task. Coordinate with active workers before delegating so the commit agent receives a stable set of changes.',
          'Ask the worker to read applicable repository instructions, inspect the changes and Git state, run required checks, fix relevant failures, stage the intended changes, commit according to repository conventions, and push to the requested destination or configured upstream. It should preserve unrelated changes and existing history, keep commit hooks enabled, and report commit hashes, checks, push outcome, and any remaining changes or blockers. If the changes are already committed, it should check whether they need pushing.',
          'Collect the result with agent_status or agent_wait before reporting completion. The worker session is automatically disposed when the task finishes; its saved result and transcript paths are available through agent_status.',
          ...(instructions
            ? [
                `Additional user instructions (apply these to the task above):\n${instructions}`,
              ]
            : []),
        ].join('\n\n'),
        {deliverAs: 'followUp'},
      );
    },
  });
}
