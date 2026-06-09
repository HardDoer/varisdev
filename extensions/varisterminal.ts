import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const THEME_NAME = "varisware";
const TITLE = "VarisTerminal";
const AVATAR = "\\_(o)>";

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
			const avatar = `${theme.fg("accent", AVATAR)} ${theme.fg("dim", "crow online")}`;

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

	ctx.ui.setTitle(TITLE);

	if (ctx.mode === "tui") {
		applyTheme(ctx);
		ctx.ui.setHeader((_tui, theme) => makeHeader(theme));
		ctx.ui.setWorkingMessage(`${AVATAR} spouting lines...`);
		ctx.ui.setWorkingIndicator({
			frames: ["\\_(o)>", "\\-(o)>", "/-(o)>", "/_(o)>"].map((frame) => ctx.ui.theme.fg("accent", frame)),
			intervalMs: 140,
		});
		ctx.ui.setHiddenThinkingLabel(`${AVATAR} thinking...`);
		ctx.ui.setStatus(
			"varisterminal",
			`${ctx.ui.theme.fg("accent", AVATAR)} ${ctx.ui.theme.fg("muted", TITLE)}`,
		);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		applyBranding(ctx);
	});

	pi.on("agent_start", async (_event, ctx) => {
		ctx.ui.setTitle(TITLE);
	});

	pi.on("agent_end", async (_event, ctx) => {
		ctx.ui.setTitle(TITLE);
	});

	pi.registerCommand("varisterminal", {
		description: "Reapply VarisTerminal branding and the Varisware theme.",
		handler: async (_args, ctx) => {
			applyBranding(ctx);
			ctx.ui.notify("VarisTerminal branding applied", "info");
		},
	});
}
