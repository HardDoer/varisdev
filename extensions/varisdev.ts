import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

const THEME_NAME = "varisware";
const TITLE = "VarisDev";
const TERMINAL_TITLE_PREFIX = TITLE;
const TITLE_REFRESH_MS = 2000;
const AVATAR = "\\_(o)>";

let titleRefresh: ReturnType<typeof setInterval> | undefined;

function unrefTimer(timer: ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>): void {
	if (typeof timer === "object" && timer && "unref" in timer) {
		(timer as { unref?: () => void }).unref?.();
	}
}

function getTerminalTitle(ctx?: ExtensionContext): string {
	const folder = ctx ? basename(ctx.cwd) : "";
	return folder ? `${TERMINAL_TITLE_PREFIX} - ${folder}` : TERMINAL_TITLE_PREFIX;
}

function applyTerminalTitle(ctx?: ExtensionContext): void {
	const terminalTitle = getTerminalTitle(ctx);
	process.title = terminalTitle;

	if (ctx?.hasUI) {
		ctx.ui.setTitle(terminalTitle);
	}

	if (ctx?.mode === "tui") {
		// OSC 2 targets the window/tab title explicitly. pi's built-in
		// title updater uses OSC 0, so emit both and keep ours last.
		process.stdout.write(`\x1b]2;${terminalTitle}\x07`);
	}
}

function keepTerminalTitle(ctx: ExtensionContext): void {
	applyTerminalTitle(ctx);

	for (const delay of [0, 50, 250, 1000]) {
		const timeout = setTimeout(() => applyTerminalTitle(ctx), delay);
		unrefTimer(timeout);
	}

	if (!titleRefresh) {
		titleRefresh = setInterval(() => applyTerminalTitle(ctx), TITLE_REFRESH_MS);
		unrefTimer(titleRefresh);
	}
}

function stopKeepingTerminalTitle(): void {
	if (!titleRefresh) return;
	clearInterval(titleRefresh);
	titleRefresh = undefined;
}

// Generated from varisware_logo-512.png as a terminal-friendly ASCII mark.
const LOGO = [
	"                         ................",
	"                    ..............@@@@@........",
	"     @@         ...........@@@@@@@@@@@@@..........   @  @",
	"  @   @@  @  .............@@@@@@@@@@@@@@@...........@@@@@@",
	"   @@@ @@@@@..................@@@@@@@@@@@.........@@@@@@@",
	"  @ @@@@@@@@@@..................@@@@@@@@@.......@@@@@@@@@@",
	"  @@@@@@@@@@@@@@@...............@@@@@@@@@@.@@@@@@@@@@@@@...",
	"   @@@@@@@@@@@@@@@@@@@......@@@@@@@@@@@@@@@@@@@@@@@@@@......",
	"    @@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@.........",
	"    ..@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@.............",
	"    .....@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@................",
	"   .........@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@.................",
	"   ................@@@@@@@@@@@@@@@@@@@@@@@@@@@..................",
	"  ...........................@@@@@@@@@@@@@@@@@..................",
	"  ...........................@@@@@@@@@@@@@@@@...................",
	"  ....+++....................@@@@@@@@@@@@@@@....................",
	"   .++++.....................@@@@@@@@@@@@@@.....................",
	"   ..+..+....................@@@@@@@@@@@@@@....................",
	"    .+++o+...................@@@@@@@@@@@...@..++@@.............",
	"    ..+++++.+................@@@@@@@@@@o+oo+o   +@+oo.........",
	"     ...++o++................@@@@@@@@+          +@+@oo.......",
	"      ..+++o..+.............@@@++ +o@+oo        o+++ +......",
	"       ...++.oo+++..........@@@+o o+@@@+          o++......",
	"         ...++.+ ++........@@@@+o o++@+     oo++..........",
	"           ....++++++.....@@.@@@+o   ooo+++.............",
	"             ...+++oo+++.....@@@...+..+..............",
	"                ...++.+o+++..........+.............",
	"                   ....+...........++..........",
	"                         ...++++++........",
];

function colorLogoLine(line: string, theme: Theme): string {
	let rendered = "";
	for (const ch of line) {
		switch (ch) {
			case ".":
				rendered += theme.fg("accent", ch);
				break;
			case "@":
				rendered += theme.fg("text", ch);
				break;
			case "+":
			case "o":
				rendered += theme.fg("warning", ch);
				break;
			default:
				rendered += ch;
		}
	}
	return rendered;
}

function centered(line: string, width: number): string {
	if (width <= 0) return "";
	const lineWidth = visibleWidth(line);
	if (lineWidth >= width) return truncateToWidth(line, width, "");
	return " ".repeat(Math.floor((width - lineWidth) / 2)) + line;
}

function makeHeader(theme: Theme) {
	return {
		render(width: number): string[] {
			const title = theme.fg("accent", theme.bold(TITLE));
			const subtitle = theme.fg("muted", "Varisware coding terminal");
			const avatar = theme.fg("dim", "Crow AI Agent Harness");

			return [
				"",
				...LOGO.map((line) => centered(colorLogoLine(line, theme), width)),
				"",
				centered(title, width),
				centered(subtitle, width),
				centered(avatar, width),
				"",
			];
		},
		invalidate() {},
	};
}

function applyTheme(ctx: ExtensionContext): boolean {
	if (ctx.mode !== "tui") return false;
	const theme = ctx.ui.getTheme(THEME_NAME);
	if (!theme) return false;
	const result = ctx.ui.setTheme(theme);
	return result.success;
}

function applyBranding(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	keepTerminalTitle(ctx);

	if (ctx.mode === "tui") {
		applyTheme(ctx);
		ctx.ui.setHeader((_tui, theme) => makeHeader(theme));
		ctx.ui.setWorkingMessage("processing...");
		ctx.ui.setWorkingIndicator({
			frames: ["\\_(o)>", "\\-(o)>", "/-(o)>", "/_(o)>"].map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 140,
		});
		ctx.ui.setHiddenThinkingLabel(`${AVATAR} thinking...`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		applyBranding(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		keepTerminalTitle(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		keepTerminalTitle(ctx);
	});

	pi.on("session_shutdown", async () => {
		stopKeepingTerminalTitle();
	});

	pi.registerCommand("varisdev", {
		description: "Reapply VarisDev branding and the Varisware theme.",
		handler: async (_args, ctx) => {
			applyBranding(ctx);
			ctx.ui.notify("VarisDev branding applied", "info");
		},
	});
}
