import type {
  ExtensionAPI,
  ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {readHandoverSettings} from './handover-settings.ts';
import {registerSessionHandover} from './session-handover.ts';

type Sessions = ReturnType<typeof registerSessionHandover>;
type Status =
  'idle' | 'requested' | 'writing' | 'ready' | 'scheduled' | 'failed';
interface Checkpoint {
  status: Status;
  attempted: boolean;
  id?: string;
  handover?: string;
}

const entryType = 'varisdev_handover';
const requestType = 'varisdev_handover_request';
const threshold = 80;
const planInstructions = `Plan and handover workflow:
For tasks with multiple steps, maintain a concise plan and record progress in the conversation or the project's task document. Follow the user's requested workflow and level of detail. Keep the current step, decisions, relevant files, verification results, unfinished work, and next action clear.
When the harness requests a handover, pause implementation and prepare a complete continuation prompt using your current understanding and tools. Update the existing plan and verify relevant file state as needed. Distinguish what the conversation reports, what current files confirm, and what remains unverified. The harness handles the session change after your final handover response.`;

/** Ask the working assistant for a handover, then optionally continue in a fresh session. */
export function registerAutoHandover(
  pi: ExtensionAPI,
  sessions: Sessions = registerSessionHandover(pi),
): void {
  let checkpoint: Checkpoint = {status: 'idle', attempted: false};
  let running = false;
  let active = true;
  let epoch = 0;
  let reportedError: string | undefined;
  let scheduledId: string | undefined;

  function save(): void {
    pi.appendEntry(entryType, {...checkpoint});
  }

  function fail(): void {
    checkpoint = {status: 'failed', attempted: true, id: checkpoint.id};
    save();
  }

  function report(error: unknown, ctx: ExtensionContext): void {
    const text = `Handover: ${error instanceof Error ? error.message : String(error)}`;
    if (text === reportedError) return;
    reportedError = text;
    ctx.ui.notify(text, 'error');
  }

  function restoreDraft(ctx: ExtensionContext): void {
    if (checkpoint.status === 'scheduled' && !sessions.hasPending(ctx)) {
      checkpoint.status = checkpoint.handover ? 'ready' : 'failed';
      save();
    }
  }

  function percent(ctx: ExtensionContext): number | undefined {
    const value = ctx.getContextUsage()?.percent;
    return value !== null && value !== undefined && Number.isFinite(value)
      ? value
      : undefined;
  }

  async function request(
    ctx: ExtensionContext,
    automatic: boolean,
    delivery: 'steer' | 'nextTurn' | 'inline' = 'steer',
  ) {
    restoreDraft(ctx);
    if (
      ['requested', 'writing', 'scheduled'].includes(checkpoint.status) ||
      sessions.hasPending(ctx) ||
      ctx.signal?.aborted
    ) {
      if (!automatic)
        ctx.ui.notify(
          'A handover or session change is already in progress.',
          'info',
        );
      return;
    }
    const generation = epoch;
    const previous = checkpoint;
    const settings = await readHandoverSettings(ctx.cwd);
    if (generation !== epoch || checkpoint !== previous || ctx.signal?.aborted)
      return;
    if (
      automatic &&
      (checkpoint.attempted || settings['auto-handover'] !== 'on')
    )
      return;
    const usage = percent(ctx);
    if (automatic && (usage === undefined || usage < threshold)) return;
    checkpoint = {status: 'requested', attempted: true, id: randomUUID()};
    reportedError = undefined;
    save();
    const transcript = ctx.sessionManager.getSessionFile();
    const message = {
      customType: requestType,
      display: true,
      details: {id: checkpoint.id, automatic, percent: usage},
      content: [
        automatic
          ? `Context usage has reached ${usage!.toFixed(1)}%, at or above the ${threshold}% handover threshold.`
          : 'The user requested a handover checkpoint.',
        'Pause implementation now and prepare a complete handover so the plan can continue in a fresh session. Use your tools to update the plan and inspect relevant files where needed. Keep this work focused on preparing the handover.',
        'Include the goal and user instructions; the complete remaining plan or the exact path to its saved document; completed parts and verified results; the current stopping point; decisions and reasons; relevant files and symbols; unfinished work and blockers; and concrete next steps in order. State clearly if the task is complete or waiting for user input.',
        'Distinguish what the conversation reports, what current files confirm, and what remains unverified. Record actual check results separately from checks still needed. Include references that let the next session recover detail without repeating finished work.',
        ...(transcript ? [`Current transcript: ${transcript}`] : []),
        'Finish with the complete handover text as your final response, within 64000 characters. This final response is the continuation prompt. The harness handles the session change after your final handover response.',
        settings['auto-session-refresh'] === 'on'
          ? 'Automatic session refresh is on. After your handover is complete, the harness starts a fresh session and tells it to continue the plan.'
          : 'Automatic session refresh is off. The completed handover will be available for the user to continue manually with /handover continue.',
      ].join('\n\n'),
    };
    if (delivery === 'inline') return message;
    pi.sendMessage(message, {deliverAs: delivery, triggerTurn: true});
    return undefined;
  }

  async function continuePlan(ctx: ExtensionContext): Promise<void> {
    restoreDraft(ctx);
    if (checkpoint.status !== 'ready' || !checkpoint.handover) {
      ctx.ui.notify(
        'No completed handover is ready. Use /handover to prepare one.',
        'info',
      );
      return;
    }
    if (sessions.hasPending(ctx)) {
      ctx.ui.notify('A session change is already pending.', 'info');
      return;
    }
    const generation = epoch;
    const ready = checkpoint;
    checkpoint = {...ready, status: 'scheduled'};
    save();
    try {
      const {details} = await sessions.schedule(ready.handover!, ctx);
      if (generation !== epoch) return;
      if (details.outcome === 'scheduled') scheduledId = details.handover.id;
      if (details.outcome === 'failed') {
        checkpoint = ready;
        save();
        report(details.handover.pendingReason, ctx);
      }
    } catch (error) {
      if (generation !== epoch) return;
      checkpoint = ready;
      save();
      if (!ctx.signal?.aborted) report(error, ctx);
    }
  }

  pi.on('session_start', (_event, ctx) => {
    epoch++;
    active = true;
    running = false;
    reportedError = undefined;
    scheduledId = undefined;
    checkpoint = {status: 'idle', attempted: false};
    const previous = ctx.sessionManager
      .getBranch()
      .findLast(
        entry => entry.type === 'custom' && entry.customType === entryType,
      );
    if (previous?.type !== 'custom') return;
    const data = previous.data as Partial<Checkpoint> | undefined;
    if (!data || typeof data.attempted !== 'boolean') return;
    const ready =
      ['ready', 'scheduled'].includes(data.status ?? '') &&
      typeof data.handover === 'string' &&
      data.handover.trim() &&
      data.handover.length <= 64000;
    checkpoint = ready
      ? {status: 'ready', attempted: true, id: data.id, handover: data.handover}
      : {status: data.attempted ? 'failed' : 'idle', attempted: data.attempted};
  });

  pi.on('before_agent_start', async (event, ctx) => {
    const result = {
      systemPrompt: `${event.systemPrompt}\n\n${planInstructions}`,
    };
    const usage = percent(ctx);
    if (checkpoint.attempted || usage === undefined || usage < threshold)
      return result;
    const generation = epoch;
    try {
      // Resumed sessions can already be above 80% without hitting Pi's native
      // compaction threshold. Add the request to this prompt, avoiding a second run.
      const message = await request(ctx, true, 'inline');
      return {...result, message};
    } catch (error) {
      if (generation === epoch) report(error, ctx);
      return result;
    }
  });
  pi.on('agent_start', () => {
    running = true;
  });

  pi.on('message_start', (event, ctx) => {
    const message = event.message;
    if (
      checkpoint.status === 'requested' &&
      message.role === 'custom' &&
      message.customType === requestType &&
      (message.details as {id?: string} | undefined)?.id === checkpoint.id
    ) {
      checkpoint.status = 'writing';
      return;
    }
    // A queued user instruction must reach the continuing session. Cancel our
    // still-waiting replacement rather than switch with an outdated handover.
    if (
      checkpoint.status === 'scheduled' &&
      message.role === 'user' &&
      scheduledId &&
      sessions.cancelPending(
        scheduledId,
        ctx,
        'A new user instruction superseded the automatic handover. The source session continues.',
      )
    ) {
      scheduledId = undefined;
      fail();
      return;
    }
    // A new user instruction supersedes a handover currently being drafted.
    // New work after a saved draft also makes that draft unsuitable to resume.
    if (
      (checkpoint.status === 'writing' && message.role === 'user') ||
      (checkpoint.status === 'ready' &&
        (message.role === 'user' || message.role === 'custom'))
    )
      fail();
    if (
      ctx.signal?.aborted &&
      ['requested', 'writing'].includes(checkpoint.status)
    )
      fail();
  });

  pi.on('turn_end', async (event, ctx) => {
    if (event.message.role !== 'assistant' || ctx.signal?.aborted) return;
    const message = event.message;
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      return;
    const generation = epoch;
    try {
      if (checkpoint.status === 'writing') {
        if (
          message.stopReason !== 'stop' ||
          message.content.some(part => part.type === 'toolCall')
        )
          return;
        const handover = message.content
          .filter(part => part.type === 'text')
          .map(part => part.text)
          .join('\n')
          .trim();
        if (!handover || handover.length > 64000) {
          fail();
          report(
            'The handover must contain 1–64000 characters. Use /handover to retry.',
            ctx,
          );
          return;
        }
        checkpoint = {...checkpoint, status: 'ready', handover};
        save();
        const completed = checkpoint;
        const settings = await readHandoverSettings(ctx.cwd);
        if (
          generation === epoch &&
          !ctx.signal?.aborted &&
          checkpoint === completed &&
          checkpoint.status === 'ready' &&
          settings['auto-session-refresh'] === 'on'
        )
          await continuePlan(ctx);
      } else if (!checkpoint.attempted) {
        const usage = percent(ctx);
        if (usage !== undefined && usage >= threshold) await request(ctx, true);
      }
    } catch (error) {
      if (generation !== epoch) return;
      if (['requested', 'writing'].includes(checkpoint.status)) fail();
      report(error, ctx);
    }
  });

  pi.on('session_before_compact', async (event, ctx) => {
    if (event.reason !== 'threshold') {
      if (['requested', 'writing'].includes(checkpoint.status)) fail();
      return undefined;
    }
    if (ctx.signal?.aborted) return undefined;
    if (
      sessions.hasPending(ctx) ||
      ['requested', 'writing'].includes(checkpoint.status)
    )
      return {cancel: true};
    if (checkpoint.attempted) return undefined;
    const generation = epoch;
    try {
      const settings = await readHandoverSettings(ctx.cwd);
      if (generation !== epoch || settings['auto-handover'] !== 'on')
        return undefined;
      const usage = percent(ctx);
      if (usage === undefined) return undefined;
      if (usage >= threshold) {
        // Before prompt submission there is no active agent loop. Queue the
        // instruction for that upcoming prompt instead of starting a second run.
        await request(ctx, true, running ? 'steer' : 'nextTurn');
      }
      // Native token reserves can trigger below 80% on smaller models. Let
      // this workflow reach its threshold; manual and overflow compaction work.
      return {cancel: true};
    } catch (error) {
      if (generation === epoch) report(error, ctx);
      return undefined;
    }
  });

  pi.on('session_compact', (_event, ctx) => {
    if (checkpoint.status === 'ready' || sessions.hasPending(ctx)) return;
    checkpoint = {status: 'idle', attempted: false};
    save();
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!active) return;
    running = false;
    restoreDraft(ctx);
    if (['requested', 'writing'].includes(checkpoint.status)) fail();
  });
  pi.on('session_shutdown', () => {
    epoch++;
    active = false;
    running = false;
  });

  pi.registerCommand('handover', {
    description:
      'Prepare a handover, or use /handover continue to resume a completed handover in a fresh session.',
    handler: async (args, ctx) => {
      const generation = epoch;
      try {
        if (!args.trim()) await request(ctx, false);
        else if (args.trim() === 'continue') await continuePlan(ctx);
        else ctx.ui.notify('Usage: /handover [continue]', 'error');
      } catch (error) {
        if (generation === epoch) report(error, ctx);
      }
    },
  });
}
