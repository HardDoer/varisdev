import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { basename } from "node:path";

const THEME_NAME = "varisware";
const TITLE = "VarisDev";
const TERMINAL_TITLE_PREFIX = TITLE;
const TITLE_REFRESH_MS = 2000;
const AVATAR = "\\_(o)>";
const CROW_DECORATION_START = "\x1b_varisdev-crow:start\x1b\\";
const CROW_DECORATION_END = "\x1b_varisdev-crow:end\x1b\\";

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

// Generated from C:\\Users\\herra\\Desktop\\spr_crow.png as compact
// true-color half-block art. Each pair is the top/bottom palette index for
// one terminal cell; 0 means transparent.
const CROW_PALETTE: Array<[number, number, number] | null> = [
	null,
	[17, 12, 124],
	[2, 2, 149],
	[44, 41, 117],
	[141, 54, 8],
	[96, 71, 63],
	[68, 66, 99],
	[87, 86, 92],
	[143, 142, 167],
	[224, 221, 222],
];
const CROW_ART_WIDTH = 22;
const CROW_ART: string[] = [
	"000000000000000000000507075756565666",
	"0000000000000000067787888878676736765204",
	"000000000000001231636773837371326637132244",
	"00000000095876636110089809012367767733124204",
	"00099998988888989896933063667667376662320204",
	"88988881316060703020010112266677762222020104",
	"857000000000000000002366663671776537202324",
	"0000000000000400122216767361336736002534",
	"0000000000004403121173122260201",
	"0000000000000000202122222100004",
	"00000000000000000050243",
	"0000000000000000004",
];

function color24([r, g, b]: [number, number, number], mode: "fg" | "bg"): string {
	return `\x1b[${mode === "fg" ? 38 : 48};2;${r};${g};${b}m`;
}

function renderCrowBlockArt(): string[] {
	return CROW_ART.map((row) => {
		let rendered = "\x1b[0m";
		for (let i = 0; i < CROW_ART_WIDTH; i++) {
			const topIndex = Number(row[i * 2] ?? "0");
			const bottomIndex = Number(row[i * 2 + 1] ?? "0");
			const top = CROW_PALETTE[topIndex];
			const bottom = CROW_PALETTE[bottomIndex];

			if (!top && !bottom) {
				rendered += " ";
			} else if (top && bottom) {
				rendered += `${color24(top, "fg")}${color24(bottom, "bg")}▀\x1b[0m`;
			} else if (top) {
				rendered += `${color24(top, "fg")}▀\x1b[0m`;
			} else if (bottom) {
				rendered += `${color24(bottom, "fg")}▄\x1b[0m`;
			}
		}
		return rendered;
	});
}

function makeCrowSpeechPrefix(theme: Theme): string {
	const art = renderCrowBlockArt();
	const bubble = [
		theme.fg("accent", "╭─ VarisDev says ─"),
		theme.fg("accent", "│"),
		theme.fg("muted", "│ caw caw"),
		theme.fg("accent", "╰───────────────"),
	];

	return art
		.map((line, index) => `${line}  ${bubble[index] ?? ""}`)
		.join("\n");
}

function decorateAssistantText(text: string, theme: Theme): string {
	if (!text.trim() || text.startsWith(CROW_DECORATION_START)) return text;
	return `${CROW_DECORATION_START}${makeCrowSpeechPrefix(theme)}${CROW_DECORATION_END}\n\n${text}`;
}

function stripCrowDecoration(text: string): string {
	if (!text.startsWith(CROW_DECORATION_START)) return text;
	const end = text.indexOf(CROW_DECORATION_END);
	if (end === -1) return text;
	return text.slice(end + CROW_DECORATION_END.length).replace(/^\n{1,2}/, "");
}

function isTextBlock(block: unknown): block is { type: "text"; text: string } {
	return (
		typeof block === "object" &&
		block !== null &&
		(block as { type?: unknown }).type === "text" &&
		typeof (block as { text?: unknown }).text === "string"
	);
}

function decorateAssistantMessage<T extends { role: "assistant"; content: unknown[] }>(message: T, theme: Theme): T {
	let decorated = false;
	let changed = false;
	const content = message.content.map((block) => {
		if (decorated || !isTextBlock(block) || !block.text.trim()) return block;
		decorated = true;
		const text = decorateAssistantText(block.text, theme);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});
	return changed ? ({ ...message, content } as T) : message;
}

function stripAssistantMessageDecoration<T extends { role?: string; content?: unknown }>(message: T): T {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return message;

	let changed = false;
	const content = message.content.map((block) => {
		if (!isTextBlock(block)) return block;
		const text = stripCrowDecoration(block.text);
		if (text === block.text) return block;
		changed = true;
		return { ...block, text };
	});

	return changed ? ({ ...message, content } as T) : message;
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

	pi.on("message_end", async (event, ctx) => {
		if (ctx.mode !== "tui" || event.message.role !== "assistant") return;
		const message = decorateAssistantMessage(event.message, ctx.ui.theme);
		if (message !== event.message) return { message };
	});

	pi.on("context", async (event) => {
		let changed = false;
		const messages = event.messages.map((message) => {
			const stripped = stripAssistantMessageDecoration(message);
			if (stripped !== message) changed = true;
			return stripped;
		});
		if (changed) return { messages };
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
