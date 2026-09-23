import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';
import type {SpawnAgent} from './agents.ts';

const instructions = [
  'You are the commit and push agent. Complete the requested commit and push workflow in the selected repository.',
  'Read and follow the applicable repository instructions, including AGENTS.md, instructions for affected subdirectories, CONTRIBUTING files, and any referenced commit, verification, and push guidance. Inspect the Git status, staged and unstaged diffs, relevant untracked files, recent commits, current branch, remotes, and upstream before choosing the steps.',
  'Use the delegated scope and context to identify the intended changes. Coordinate with active agents before touching their files. Preserve unrelated changes and existing work; stage only changes in scope and inspect the complete staged diff before committing. Respect the repository conventions for commit messages and grouping changes into commits.',
  'Run the checks required by the repository and appropriate to the changes. Use the supplied verification results when they still cover the current files and repository instructions allow it. Fix relevant failures, inspect any resulting edits, and rerun affected checks before committing. Keep fixes within the requested scope; report blockers that require broader work. Keep commit hooks enabled.',
  'Commit the intended changes, then push to the destination specified by the task or repository instructions, otherwise the configured upstream. When no upstream exists, use a remote and branch only if the intended destination is unambiguous and set the upstream. Inspect outgoing commits before pushing. Preserve existing history; do not amend, reset, rebase, or force-push unless explicitly requested. Report an ambiguous destination or a rejected push as a blocker.',
  'If the intended changes are already committed, inspect whether they still need pushing. If everything is already committed and pushed, report that without creating an empty commit. Verify the push result and final Git status. Report commit hashes and subjects, checks and outcomes, the pushed remote and branch, and remaining changes or blockers. If a commit succeeds but the push fails, report both outcomes accurately.',
].join('\n\n');

/** A fixed model and task policy on the existing background agent lifecycle. */
export function registerGitCommitPushTool(
  pi: ExtensionAPI,
  spawn: SpawnAgent,
): void {
  pi.registerTool({
    name: 'git_commit_push',
    label: 'Commit and push changes',
    description:
      'Start a background Codex GPT-5.5 agent with xhigh reasoning to inspect changes, follow repository instructions, run required checks, commit, and push. Returns an agent ID immediately; use agent_status or agent_wait for the result and agent_cancel to cancel.',
    promptSnippet:
      'Delegate committing and pushing changes to Codex GPT-5.5 with xhigh reasoning.',
    promptGuidelines: [
      'Use git_commit_push when the user asks to commit and push. Include the intended change scope, relevant user instructions, completed checks, and any requested commit message or push destination in task. The worker reads repository instructions; it does not receive the parent conversation.',
      'Finish edits and coordinate other workers in the repository before delegating. Collect the result with agent_status or agent_wait before reporting that changes were committed and pushed.',
    ],
    parameters: Type.Object({
      task: Type.String({
        minLength: 1,
        maxLength: 60000,
        description:
          'Changes to commit and push, relevant context and user instructions, and checks already completed. Include a commit message or remote/branch here when requested; otherwise the agent follows repository conventions.',
      }),
      cwd: Type.Optional(
        Type.String({
          description:
            'Repository working directory, relative to the current project. Defaults to the current directory.',
        }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      signal?.throwIfAborted();
      if (!params.task.trim()) {
        throw new Error('Commit and push task cannot be empty.');
      }
      return spawn(
        {
          name: 'Commit and push',
          task: `Commit and push the changes described below.\n\nScope and context:\n${params.task}`,
          cwd: params.cwd,
          instructions,
          model: 'openai-codex/gpt-5.5',
          thinkingLevel: 'xhigh',
          notify: true,
        },
        signal,
        ctx,
      );
    },
  });
}
