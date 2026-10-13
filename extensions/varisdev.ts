import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from '@earendil-works/pi-coding-agent';
import {truncateToWidth, visibleWidth} from '@earendil-works/pi-tui';
import {basename} from 'node:path';
import {registerCompletionAlert} from '../src/completion-alert.ts';
import {registerCommitCommand} from '../src/commit.ts';
import {registerImagePreviews} from '../src/image-previews.ts';
import {registerFactory} from '../src/dashboard/index.ts';
import {registerAgentTools} from '../src/tools/agents.ts';
import {registerProjectTools} from '../src/tools/index.ts';

const THEME_NAME = 'varisware';
const TITLE = 'VarisDev';
const TERMINAL_TITLE_PREFIX = TITLE;
const TITLE_REFRESH_MS = 2000;

function unrefTimer(
  timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>,
): void {
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as {unref?: () => void}).unref?.();
  }
}

function getTerminalTitle(ctx?: ExtensionContext): string {
  const folder = ctx ? basename(ctx.cwd) : '';
  return folder
    ? `${TERMINAL_TITLE_PREFIX} - ${folder}`
    : TERMINAL_TITLE_PREFIX;
}

function applyTerminalTitle(ctx?: ExtensionContext): void {
  const terminalTitle = getTerminalTitle(ctx);
  if (ctx?.mode === 'tui') process.title = terminalTitle;

  if (ctx?.hasUI) {
    ctx.ui.setTitle(terminalTitle);
  }

  if (ctx?.mode === 'tui') {
    // OSC 2 targets the window/tab title explicitly. pi's built-in
    // title updater uses OSC 0, so emit both and keep ours last.
    process.stdout.write(`\x1b]2;${terminalTitle}\x07`);
  }
}

// Generated from varisware_logo-512.png as a terminal-friendly ASCII mark.
const LOGO = [
  '                         ................',
  '                    ..............@@@@@........',
  '     @@         ...........@@@@@@@@@@@@@..........   @  @',
  '  @   @@  @  .............@@@@@@@@@@@@@@@...........@@@@@@',
  '   @@@ @@@@@..................@@@@@@@@@@@.........@@@@@@@',
  '  @ @@@@@@@@@@..................@@@@@@@@@.......@@@@@@@@@@',
  '  @@@@@@@@@@@@@@@...............@@@@@@@@@@.@@@@@@@@@@@@@...',
  '   @@@@@@@@@@@@@@@@@@@......@@@@@@@@@@@@@@@@@@@@@@@@@@......',
  '    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@.........',
  '    ..@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@.............',
  '    .....@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@................',
  '   .........@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@.................',
  '   ................@@@@@@@@@@@@@@@@@@@@@@@@@@@..................',
  '  ...........................@@@@@@@@@@@@@@@@@..................',
  '  ...........................@@@@@@@@@@@@@@@@...................',
  '  ....+++....................@@@@@@@@@@@@@@@....................',
  '   .++++.....................@@@@@@@@@@@@@@.....................',
  '   ..+..+....................@@@@@@@@@@@@@@....................',
  '    .+++o+...................@@@@@@@@@@@...@..++@@.............',
  '    ..+++++.+................@@@@@@@@@@o+oo+o   +@+oo.........',
  '     ...++o++................@@@@@@@@+          +@+@oo.......',
  '      ..+++o..+.............@@@++ +o@+oo        o+++ +......',
  '       ...++.oo+++..........@@@+o o+@@@+          o++......',
  '         ...++.+ ++........@@@@+o o++@+     oo++..........',
  '           ....++++++.....@@.@@@+o   ooo+++.............',
  '             ...+++oo+++.....@@@...+..+..............',
  '                ...++.+o+++..........+.............',
  '                   ....+...........++..........',
  '                         ...++++++........',
];

const LOGO_TRUECOLOR = {
  background: '\x1b[38;2;209;0;209m',
  crow: '\x1b[38;2;247;239;247m',
  controller: '\x1b[38;2;255;209;102m',
};
const LOGO_256_COLOR = {
  background: '\x1b[38;5;164m',
  crow: '\x1b[38;5;255m',
  controller: '\x1b[38;5;221m',
};
const FOREGROUND_RESET = '\x1b[39m';

function colorLogoLine(line: string, theme: Theme): string {
  const palette =
    theme.getColorMode() === 'truecolor' ? LOGO_TRUECOLOR : LOGO_256_COLOR;
  return line
    .replace(
      /\.+/g,
      background => `${palette.background}${background}${FOREGROUND_RESET}`,
    )
    .replace(/@+/g, crow => `${palette.crow}${crow}${FOREGROUND_RESET}`)
    .replace(
      /[+o]+/g,
      controller => `${palette.controller}${controller}${FOREGROUND_RESET}`,
    );
}

function centered(line: string, width: number): string {
  if (width <= 0) return '';
  const lineWidth = visibleWidth(line);
  if (lineWidth >= width) return truncateToWidth(line, width, '');
  return ' '.repeat(Math.floor((width - lineWidth) / 2)) + line;
}

function makeProcessingFrame(theme: Theme, dotCount: number): string {
  const dots = '.'.repeat(dotCount).padEnd(3, ' ');
  return theme.fg('muted', `Processing${dots}`);
}

function makeProcessingFrames(theme: Theme): string[] {
  return [0, 1, 2, 3].map(dotCount => makeProcessingFrame(theme, dotCount));
}

function makeHeader(theme: Theme) {
  return {
    render(width: number): string[] {
      const title = theme.fg('accent', theme.bold(TITLE));
      const subtitle = theme.fg('muted', 'VarisWare AI Agent Harness');

      return [
        '',
        ...LOGO.map(line => centered(colorLogoLine(line, theme), width)),
        '',
        centered(title, width),
        centered(subtitle, width),
        '',
      ];
    },
    invalidate() {},
  };
}

function applyTheme(ctx: ExtensionContext): boolean {
  if (ctx.mode !== 'tui') return false;
  const theme = ctx.ui.getTheme(THEME_NAME);
  if (!theme) return false;
  const result = ctx.ui.setTheme(theme);
  return result.success;
}

export default function (pi: ExtensionAPI) {
  let titleRefresh: ReturnType<typeof setInterval> | undefined;
  const titleTimeouts = new Set<ReturnType<typeof setTimeout>>();

  function stopKeepingTerminalTitle(): void {
    if (titleRefresh !== undefined) {
      clearInterval(titleRefresh);
      titleRefresh = undefined;
    }
    for (const timeout of titleTimeouts) clearTimeout(timeout);
    titleTimeouts.clear();
  }

  function keepTerminalTitle(ctx: ExtensionContext): void {
    // All callbacks belong to this extension instance. Cancel the previous
    // batch before capturing a context, and release it on session shutdown.
    stopKeepingTerminalTitle();
    applyTerminalTitle(ctx);

    for (const delay of [0, 50, 250, 1000]) {
      const timeout = setTimeout(() => {
        titleTimeouts.delete(timeout);
        applyTerminalTitle(ctx);
      }, delay);
      titleTimeouts.add(timeout);
      unrefTimer(timeout);
    }

    titleRefresh = setInterval(() => applyTerminalTitle(ctx), TITLE_REFRESH_MS);
    unrefTimer(titleRefresh);
  }

  function applyBranding(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;

    keepTerminalTitle(ctx);

    if (ctx.mode === 'tui') {
      applyTheme(ctx);
      ctx.ui.setHeader((_tui, theme) => makeHeader(theme));
      ctx.ui.setWorkingMessage('');
      ctx.ui.setWorkingIndicator({
        frames: makeProcessingFrames(ctx.ui.theme),
        intervalMs: 240,
      });
      ctx.ui.setHiddenThinkingLabel('thinking...');
    }
  }

  registerImagePreviews(pi);
  registerProjectTools(pi);
  const agents = registerAgentTools(pi);
  // The desktop observer shares this controller when this extension is loaded.
  // Resource loaders execute configured extensions before their inline factories.
  const releaseController = pi.events.on(
    'varisdev:dashboard-controller',
    request => {
      (request as {control?: typeof agents}).control = agents;
    },
  );
  registerFactory(pi, agents);
  registerCommitCommand(pi);
  registerCompletionAlert(pi);
  pi.on('session_start', async (_event, ctx) => {
    applyBranding(ctx);
  });

  pi.on('agent_start', async (_event, ctx) => {
    keepTerminalTitle(ctx);
  });

  pi.on('agent_end', async (_event, ctx) => {
    keepTerminalTitle(ctx);
  });

  pi.on('session_shutdown', async () => {
    releaseController();
    stopKeepingTerminalTitle();
  });

  pi.registerCommand('varisdev', {
    description: 'Reapply VarisDev branding and the Varisware theme.',
    handler: async (_args, ctx) => {
      applyBranding(ctx);
      ctx.ui.notify('VarisDev branding applied', 'info');
    },
  });
}
