import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import JSON5 from 'json5';
import {registerQueryTool} from './json-query.ts';

export function registerGameMakerQueryTool(pi: ExtensionAPI): void {
  registerQueryTool(pi, {
    name: 'gamemaker_query',
    label: 'GameMaker Query',
    description:
      "Inspect and query one or many GameMaker .yy and .yyp resource files without writing an ad-hoc script. Accepts GameMaker's JSON-like format, including trailing commas. Supports globbing, root-key inspection, exact nested-field filters, per-file group counts, and selected samples. Output is truncated to 2000 lines or 50KB, with full output saved to a temporary file.",
    promptSnippet:
      'Inspect and summarize GameMaker .yy and .yyp resource files, including their trailing-comma JSON-like syntax.',
    promptGuidelines: [
      'Use gamemaker_query instead of json_query or ad-hoc Python, Node, jq, or shell scripts when inspecting GameMaker .yy and .yyp files; gamemaker_query accepts their trailing-comma JSON-like syntax.',
      'Trailing commas are normal in GameMaker .yy and .yyp files. Do not remove them or report file corruption merely because a strict JSON parser rejects them.',
      'gamemaker_query paths accept dot-separated fields such as properties.owner_id or RFC 6901 JSON Pointers for keys containing dots or slashes.',
      'Use gamemaker_query collectionPath for a nested array, where for exact filters, groupBy for Counter-style counts, and select plus sampleLimit for representative records.',
      'If you notice unexpected or unfinished behavior when using gamemaker_query, report it to the user.',
    ],
    documentLabel: 'GameMaker files',
    parseDocument: source => JSON5.parse<unknown>(source),
  });
}
