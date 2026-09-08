# Varisware Pi/pidev plugins

Varisware VarisDev package.

## Included

- `extensions/varisdev.ts` — replaces the startup header with the three-color Varisware ASCII logo, keeps the tab/window title set to `VarisDev - <folder>`, uses a small crow image-style loader with animated processing dots while the assistant is streaming, raises a completion alert when the agent settles, and registers VarisDev tools.
- `src/tools/browse.ts` — agent-callable `browse` tool for compact HTTP/HTTPS browsing without dumping response headers or large body samples into the LLM context.
- `src/tools/download.ts` — agent-callable `download` tool for streaming HTTP/HTTPS responses to project files.
- `src/tools/gamemaker-query.ts` — agent-callable `gamemaker_query` tool for inspecting, filtering, grouping, and sampling trailing-comma GameMaker `.yy` and `.yyp` files.
- `src/tools/image-query.ts` — agent-callable `image_query` tool for inspecting image metadata, transparency, visible bounds, and grid occupancy across files without one-off scripts.
- `src/tools/json-query.ts` — agent-callable `json_query` tool for inspecting, filtering, grouping, and sampling JSON files without one-off scripts.
- `src/tools/openai-image.ts` — agent-callable `openai_image` tool that creates or edits images with the OpenAI Images API and saves them to files.
- `src/tools/agents.ts` and `src/agents/` — background agent orchestration with spawning, progress, results, follow-up messages, waiting, and cancellation.
- `themes/varisware.json` — Varisware phosphor-green terminal theme.

## Agent orchestration

VarisDev can delegate work to background Pi agents while the parent continues working. Each agent has its own conversation, uses the parent’s model, credentials, and thinking level by default, and receives the project’s context files, skills, built-in coding tools, and VarisDev project tools. Include the relevant context in the task; the parent conversation is not copied. Workers load the shared project tools directly, so they have no orchestration tools or terminal branding.

| Tool | Purpose |
| --- | --- |
| `agent_spawn` | Start an agent and immediately return its ID. |
| `agent_list` | List active agents and status counts; use `view: "history"` for finished agents or `view: "all"` for both. |
| `agent_status` | Read one agent’s latest result, error, and transcript paths. |
| `agent_send` | Queue follow-up instructions or resume a completed agent’s conversation. |
| `agent_wait` | Wait for any or all selected agents and collect their results. |
| `agent_cancel` | Cancel an agent and discard its pending messages. |

For example, call `agent_spawn` with:

```json
{
  "name": "reviewer",
  "task": "Review src/tools/browse.ts for response truncation bugs. Report findings with file and line references.",
  "instructions": "Inspect and report findings; leave fixes to the parent agent.",
  "notify": false
}
```

Spawn another independent task the same way, then collect both results with `agent_wait`:

```json
{
  "ids": ["<first agent ID>", "<second agent ID>"],
  "mode": "all",
  "timeoutMs": 60000
}
```

Send additional work through `agent_send`:

```json
{
  "id": "<first agent ID>",
  "message": "Implement the first finding and run the relevant checks. You own src/tools/browse.ts for this change."
}
```

Four agents run concurrently; additional agents queue. An agent moves through `queued`, `running`, and `completed` or `failed`. Cancelling active work first reports `cancelling`, then `cancelled` when its tools stop. Follow-up messages run in order after the current task, retaining the conversation. Failed and cancelled agents require a new spawn.

Spawn options include `cwd` (relative to the parent directory), `model` (`provider/model-id`), `instructions`, `timeoutMs`, and `notify`. The default execution timeout is ten minutes, including initialization and pending follow-up messages, with a maximum of one hour. Queue time is excluded. Sending new work to a completed agent starts a fresh timeout. Each parent session can hold 64 agents, with up to 32 pending messages per agent.

By default, completion sends the parent a message and triggers a follow-up turn. Set `notify: false` when collecting results explicitly. `agent_wait` defaults to all agents and a 60-second wait, capped at 120 seconds; `timeoutMs: 0` polls immediately. A wait timeout or interrupted wait leaves agents running. In `any` mode, an already finished agent satisfies the wait.

Agents share their selected working directory and can change its files. Assign file ownership in each task, or provide separate working directories for independent edits. The terminal footer shows active agent counts.

- `/agents` shows queued, running, and cancelling agents, with a hint when finished agents are available in history.
- `/agents history` shows completed, failed, and cancelled agents, newest first.
- `/agents all` shows active agents followed by history.
- `/agents cancel <id|all>` cancels work manually.

`agent_list` uses the same views and defaults to active agents. Its summary counts every status across the session, including agents outside the selected view. List entries include names, IDs, activity, pending message counts, and failure reasons; use `agent_status` for full results and transcript paths. Failures show their cause, such as `Timed out after 10 minutes.` Finished agents stay available in history, and completed agents return to the active view when sent new work.

Transcripts and the latest full result are saved under `~/.pi/agent/varisdev/agents/<parent-session-id>/<agent-id>/` (or the configured Pi agent directory). Tool output is bounded and includes `sessionFile` and `resultFile` paths for inspection with `read`. The live agent list belongs to the parent session: quitting, reloading, replacing, or forking that session cancels its active workers and disposes their conversations. Saved files remain available after shutdown.

## Completion sound

In interactive mode, VarisDev tracks terminal focus and raises an alert only when the terminal is unfocused as the `agent_settled` event fires. This waits until automatic retries, compaction, and queued follow-up work have finished.

Focus detection uses the standard terminal focus-reporting protocol and works across supported macOS, Windows, and Linux terminals. When running inside tmux, `set -g focus-events on` may be required. An unfocused completion also requests visual attention: iTerm2 bounces its Dock icon once, Windows flashes the owning terminal or IDE window, and other terminals receive the standard bell/urgency signal. A completed terminal progress indicator remains visible until focus returns.

On macOS, the alert uses the terminal's own bell and does not play the bundled sound. Windows plays `assets/windows_98_ding.wav` through PowerShell, while Linux uses the first available common audio player (`pw-play`, `paplay`, `aplay`, `canberra-gtk-play`, `ffplay`, or `play`). Visual bell, urgency, Dock behavior, and the macOS bell sound can still depend on terminal settings.

## Browse tool

The `browse` tool replaces raw HTTP dumps with compact browser-oriented views:

- default `auto` view: status, content type, title, and extracted text capped at 6k characters
- `links` view: deduplicated page links, capped at 25 by default
- `raw` view: bounded raw text for API/plain-text responses
- `none` view: status-only checks
- `jsonPointers`: RFC 6901 pointers that select exact fields from JSON responses; selection reads up to 10 MiB and allows up to 24k output characters by default while returning only the selected JSON

Use `browse` for all HTTP/HTTPS access and web research. Do not fetch URLs through `bash` or shell programs such as `curl`, `wget`, PowerShell, Node, or Python. If a result is truncated or the relevant content is not in the initial excerpt, retry with a more targeted URL, `jsonPointers`, `links` view, or a larger `maxChars`; truncation is not a reason to switch to a shell HTTP client.

For example, exact definitions can be extracted from a large API discovery document without downloading it through the shell:

```json
{
  "url": "https://androidpublisher.googleapis.com/$discovery/rest?version=v3",
  "jsonPointers": [
    "/resources/edits/resources/tracks/methods/update",
    "/resources/edits/resources/bundles/methods/upload",
    "/schemas/Track",
    "/schemas/TrackRelease"
  ]
}
```

JSON Pointer tokens escape `~` as `~0` and `/` as `~1`. The empty pointer (`""`) selects the whole document. `jsonPointers` cannot be combined with `links` or `none` views.

Full response headers remain available in tool `details` for rendering/debugging, but are not included in LLM-visible tool text by default.

## JSON query tool

The `json_query` tool replaces common inline Python, Node, and `jq` inspection scripts. It accepts a file path or glob, supports JSON in files with custom extensions, and can report root keys, exact nested-field filters, Counter-style groups, and selected samples per file.

For example, this replaces a script that scans map files, selects neutral outposts, and counts their owners:

```json
{
  "path": "datafiles/maps/*.lmap",
  "collectionPath": "objects",
  "where": {
    "objectId": "obj_neutral_outpost"
  },
  "groupBy": [
    "properties.owner_id"
  ],
  "includeRootKeys": true
}
```

Field paths may be dot-separated (`properties.owner_id`) or RFC 6901 JSON Pointers (`/properties/owner_id`). Use `select` with `sampleLimit` to inspect representative matching records. Results are capped at 2,000 lines or 50 KiB; complete output is saved to a temporary file when truncated.

## GameMaker query tool

The `gamemaker_query` tool provides the same filtering, grouping, sampling, glob, and field-path operations as `json_query`, but parses GameMaker `.yy` resource and `.yyp` project files in their JSON-like format. In particular, it accepts the trailing commas that make these valid GameMaker resources but invalid strict JSON.

For example, this scans object resources, keeps GameMaker object definitions, groups them by parent, and samples useful identity fields:

```json
{
  "path": "objects/*/*.yy",
  "where": {
    "$GMObject": ""
  },
  "groupBy": [
    "parent.path"
  ],
  "select": [
    "name",
    "spriteId.name"
  ],
  "sampleLimit": 5,
  "includeRootKeys": true
}
```

Use `gamemaker_query` rather than `json_query` for `.yy` and `.yyp` files. Parse failures are reported per file, so a glob can still return successful resources when only some matches are malformed. Results use the same 2,000-line and 50-KiB limits as `json_query`.

## Image query tool

The `image_query` tool replaces one-off Pillow, ImageMagick, Node, and shell scripts used to inspect local images. It accepts a file path or glob and reports dimensions, format, alpha statistics, and the bounding box of pixels whose alpha exceeds a configurable threshold. An optional fixed-size grid returns row-major alpha occupancy counts for sprite sheets and tiles.

For example, this inspects every 32×32 mech sprite as four 16×16 regions while omitting icon directories:

```json
{
  "path": "sprites/spr_light_mech_*/*.png",
  "exclude": ["sprites/spr_light_mech_*_icon/**"],
  "grid": {
    "cellWidth": 16,
    "cellHeight": 16
  }
}
```

The default `alphaThreshold` is `0`, so occupancy means the same as `alpha > 0`. Edge cells are clipped when image dimensions are not exact multiples of the grid size. Multi-page images inspect their first page. Results are capped at 2,000 lines or 50 KiB; complete output is saved to a temporary file when truncated.

## OpenAI image tool

Configure the API key through the environment before starting Pi:

```bash
export OPENAI_API_KEY="sk-..."
```

The image model is fixed to `gpt-image-2`. Dimensions can be requested per tool call via the `size` argument. Image quality is a tool parameter that the agent can choose from the user's request, defaulting to `auto` when unspecified.

The `openai_image` tool can also use existing local PNG, JPEG, or WebP images by passing `inputImagePaths`, an array of up to 16 local file paths. Tool callers should pass local paths only, not raw base64 strings. The tool reads each file, converts it internally to a base64-backed OpenAI upload payload, and sends an edit request with one or more input images instead of a pure generation request.

Optional defaults:

```bash
export OPENAI_IMAGE_SIZE="1024x1024"
export OPENAI_IMAGE_OUTPUT_DIR="generated-images"
```

## Development

This repo targets Node.js 24+ and uses Google's TypeScript Style via `gts`.

```bash
npm run lint
npm run typecheck
npm test
npm run fix
```

## Local test

```bash
npm install
pi -e ./extensions/varisdev.ts
```

## Install from this repo

```bash
pi install git:git@github.com:varisware/pidev-plugins
```

Pin a tag or commit when sharing with the team:

```bash
pi install git:git@github.com:varisware/pidev-plugins@v0.1.0
```

If needed, reapply branding inside Pi with:

```txt
/varisdev
```
