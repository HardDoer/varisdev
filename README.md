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
- `src/tools/agents.ts` and `src/agents/` — background agent orchestration with spawning, progress, results, direct messages between agents, fresh sessions with handovers, waiting, and cancellation.
- `src/tools/session-new.ts` — starts a fresh parent session from a handover and continues automatically while keeping its background agents.
- `src/auto-handover.ts` and `src/handover-settings.ts` — prepare a handover with a temporary Codex GPT 5.6 high agent at 90% context and optionally continue the plan in a fresh parent session.
- `themes/varisware.json` — Varisware phosphor-green terminal theme.

## Automatic handovers

VarisDev automates **plan → implementation → handover → fresh parent → continue the plan**. Both automation switches default to `on`:

- **`auto-handover`**: when context usage reaches **90% or higher**, the harness asks the working parent to pause after the current tool batch finishes. It requests one automatic handover per conversation.
- **`auto-session-refresh`**: when the handover agent finishes, the harness starts a fresh parent session using its summary and tells it to continue the plan.

The parent finishes its turn with a brief acknowledgement. A dedicated **Codex GPT 5.6** agent (`openai-codex/gpt-5.6`) with **high** reasoning then reads a snapshot of the current conversation, parent instructions, and relevant project files. It writes the continuation prompt with the remaining plan or its saved path, completed work, decisions, file references, check results, remaining uncertainties, known background agent assignments, and precise next steps. It distinguishes conversation reports, current file evidence, and unverified claims.

Only a completed final response from the handover agent is accepted. Interrupted, failed, truncated, empty, or oversized summaries do not start a fresh parent. A new user instruction supersedes a handover being drafted or waiting to switch sessions. The harness displays the completed draft and schedules the session change after the parent turn settles. The configured Codex model must be available through the parent's model registry and credentials; preparation errors leave the source session available for a retry with `/handover`.

The handover agent belongs to the source session and is destroyed when that session changes or shuts down. A later handover creates a new agent. Its source snapshot, transcript, and result remain under `~/.pi/agent/varisdev/handovers/<source-session-id>/<request-id>/` (or the configured Pi agent directory).

The destination receives the handover and normal system/project instructions. Existing background workers retain their IDs, conversations, and queued work. Their notifications are buffered by the existing parent handover machinery when the session change is scheduled.

### Configure automation

Use these commands to save a setting for the current project:

```text
/auto-handover on
/auto-session-refresh on
```

Each command accepts `on` or `off`; omit the argument to show the current settings. For example, leave `auto-handover` on and turn `auto-session-refresh` off to receive handover drafts without automatically switching sessions.

Settings are read from `~/.pi/agent/varisdev.json` (or the configured Pi agent directory), then overridden by `<project>/.pi/varisdev.json`:

```json
{
  "auto-handover": "on",
  "auto-session-refresh": "on"
}
```

The switches are independent. Disabling automatic prompts still allows a manually requested handover to start a fresh parent when automatic refresh is on. Changes to the refresh setting apply when the handover finishes; enabling it does not immediately consume an existing draft.

### Manual steps

- **`/handover`** pauses the parent and runs the handover agent now, at any context usage.
- **`/handover continue`** starts a fresh parent from the most recent completed draft.

With both switches off, use those two commands to control each step. Completed drafts survive reloads and session resumes; new work invalidates an older draft. An interrupted handover can be requested again with `/handover`.

VarisDev blocks native compaction in parent sessions, including automatic threshold compaction, overflow compaction, and manual `/compact`. Compaction stays blocked when handover automation is off, context usage is unknown, or a handover fails or is interrupted. Use `/handover` to retry preparation, or `/handover continue` to retry a session change from a completed draft. Background agents use their existing session behavior.

## Agent orchestration

VarisDev can delegate work to background Pi agents while the parent continues working. Each agent has its own conversation, uses the parent’s model, credentials, and thinking level by default, and receives the project’s context files, skills, built-in coding tools, and VarisDev project tools. Include the relevant context in the task; the parent conversation is not copied. Workers also receive `agent_list` and `agent_send` to communicate directly with peers and the parent, and `agent_new_session` to continue work in a fresh conversation.

| Tool | Purpose |
| --- | --- |
| `session_new` | Schedule a fresh parent session, carry over its background agents, and continue automatically from a handover. Returns a request ID and state. |
| `session_handover_status` | Inspect a handover by ID or list recent requests and their delivery states. |
| `session_handover_update` | Replace handover text before dispatch and increment its revision. |
| `session_handover_cancel` | Cancel a handover before session replacement begins. |
| `agent_spawn` | Start an agent and immediately return its ID. |
| `agent_list` | List active agents and status counts; use `view: "history"` for finished agents or `view: "all"` for both. |
| `agent_status` | Read one agent’s latest result, error, and transcript paths. |
| `agent_send` | Send instructions or replace selected pending messages with `supersedes`. Workers can also message `"parent"`. |
| `agent_messages` | List message previews or retrieve one full message by ID, including its current delivery state. |
| `agent_message_remove` | Remove selected pending messages while the active task continues. |
| `agent_new_session` | Start a fresh background agent conversation and continue automatically from a handover. |
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

Workers use `agent_list` to discover peers by name and ID in the same parent session. Their list also includes `selfId`, and their system instructions include their own ID. A worker can call `agent_send` with a peer’s ID using the example above, or send a progress update or question directly to the parent:

```json
{
  "id": "parent",
  "message": "The asset dimensions are confirmed. Please use a 32-pixel grid."
}
```

Worker messages automatically identify the sender by name and ID. Messages to peers enter the recipient’s follow-up queue; messages to the parent trigger a follow-up turn, including when the sender has `notify: false`. Communication tools are scoped to the parent session. Workers have `agent_list`, `agent_send`, `agent_messages`, `agent_message_remove`, and `agent_new_session`; the parent also manages spawning, status, waiting, and cancellation.

Four agents run concurrently; additional agents queue. An agent moves through `queued`, `running`, and `completed` or `failed`. Cancelling active work first reports `cancelling`, then `cancelled` when its tools stop. Follow-up messages run in order after the current task, retaining the conversation. Failed and cancelled agents require a new spawn.

Spawn options include `cwd` (relative to the parent directory), `model` (`provider/model-id`), `instructions`, `timeoutMs`, and `notify`. Agents have no execution deadline by default. Set `timeoutMs` to impose a deadline of up to one hour, including initialization and pending follow-up messages. Use this for less capable models, such as models below GPT-5.5, when you want a hard stop. Queue time is excluded. When configured, the timeout starts afresh when a completed agent receives new work or an agent starts a fresh session after its previous tools have stopped. Each parent session can hold 64 agents, with up to 32 pending messages and one pending handover per agent.

By default, completion sends the parent a message and triggers a follow-up turn. Set `notify: false` when collecting results explicitly. `agent_wait` defaults to all agents and a 60-second wait, capped at 120 seconds; `timeoutMs: 0` polls immediately. A wait timeout or interrupted wait leaves agents running. In `any` mode, an already finished agent satisfies the wait.

Agents share their selected working directory and can change its files. Assign file ownership in each task, or provide separate working directories for independent edits. The terminal footer shows active agent counts.

- `/agents` shows queued, running, and cancelling agents, with a hint when finished agents are available in history.
- `/agents history` shows completed, failed, and cancelled agents, newest first.
- `/agents all` shows active agents followed by history.
- `/agents cancel <id|all>` cancels work manually.

`agent_list` uses the same views and defaults to active agents. Its summary counts every status across the session, including agents outside the selected view. List entries include names, IDs, activity, pending message counts, and failure reasons; use `agent_status` for full results and transcript paths. Failures show their cause, such as `Missing credentials`. Finished agents stay available in history, and completed agents return to the active view when sent new work.

Transcripts and the latest full result are saved under `~/.pi/agent/varisdev/agents/<parent-session-id>/<agent-id>/` (or the configured Pi agent directory). Tool output is bounded and includes `sessionFile` and `resultFile` paths for inspection with `read`. The live agent list follows the parent across `session_new` handovers. Quitting, reloading, manually starting or switching sessions, or forking cancels the current agents and disposes their conversations. Saved files remain available after shutdown.

### Inspecting and revising agent queues

`agent_send` returns the new message ID, sender identity, creation time, and current state. Its optional `reference` associates the instruction with a task or artifact, such as an issue ID or file path. Initial task messages also have IDs and sender metadata.

Call `agent_messages` with `{"id":"<agent ID>"}` to inspect pending messages in delivery order. Each entry has a preview of up to 500 characters; `limit` defaults to 10 and is capped at 20. Use `offset` and `nextOffset` for subsequent pages. `view: "history"` shows delivered, removed, superseded, and discarded entries; `view: "all"` includes both pending entries and history. Retrieve the full text and latest state using `{"id":"<agent ID>","messageId":"<message ID>"}`. Message history remains available for the lifetime of the team, including across handovers. `pendingHandover` separately reports a background session handover.

Consolidate obsolete pending instructions with `agent_send`:

```json
{
  "id": "<agent ID>",
  "message": "The review findings are resolved. Build the updated project and report the result.",
  "reference": "build/plan.md",
  "supersedes": ["<obsolete review message ID>", "<obsolete build message ID>"]
}
```

The new message takes the earliest selected position and preserves the order of unrelated instructions. This works even with 32 pending messages. Replaced entries report `superseded` and `replacedBy`. To remove instructions, call `agent_message_remove` with `id` and `messageIds`.

Both edits validate all selected IDs before changing the queue. If any selected entry has left the queue, the response is `not_pending`, includes the current states, and makes no changes. `delivered` means the instruction was handed to the worker and work may have started; edits cannot undo that work. Cancellation and failures mark undelivered instructions `discarded`.

### Fresh parent sessions

The parent calls `session_new` to clear its accumulated conversation and continue working automatically:

```json
{
  "handover": "Continue the asset pipeline. The user requested automatic parent handovers near 90% context usage. The plan and progress are in build/asset-plan.md. Asset generation and validation agents are still working; use agent_list to find them. Next, collect their results, resolve validation failures, and continue the remaining batches."
}
```

This creates a new parent session ID and transcript. Its model context starts with the handover and normal system/project instructions. Previous messages and tool outputs remain in the old transcript on disk. The old conversation is excluded from the new model context.

Background agents keep running throughout the handover. The new parent can list, message, wait for, and cancel them using their existing IDs. Worker messages and completion reports are buffered as soon as the handover is scheduled, so new worker notifications cannot keep adding turns while the parent waits for idle. They are delivered to the destination after the switch, or to the source if the request is cancelled. Model selection, thinking level, and active tools carry over.

Make `session_new` the last tool call in the current conversation and finish that turn. The tool waits for the parent to become idle, switches sessions, and starts the handover automatically. A standing instruction for an ongoing workflow, including your preferred context threshold, covers repeated handovers. Its instructions tell agents to finish ordinary tasks in the current session.

`session_new` returns a handover request with an `id`, state, timestamps, source and destination session information, and `pendingReason`. Repeating it while a request is pending returns `already_pending` with that request. Inspect it using `session_handover_status` with `{"id":"<request ID>"}`; omit `id` to list recent requests with previews. The latest 50 requests remain available across parent handovers in the running application.

States progress through `scheduled`, `waiting_for_idle`, and `switching`, then `completed`, `cancelled`, or `failed`. Completion confirms that the destination received the handover prompt. It reports the exact `deliveredRevision`.

If circumstances change while a request is pending:

- Call `session_handover_update` with `id` and the complete replacement `handover`. Each update increments `revision`. Updates are accepted until prompt dispatch, including during session replacement.
- Call `session_handover_cancel` with `id` before replacement begins. Once `switching` starts, the host may have disposed the source and cancellation returns `too_late`.
- Inspect `canUpdate`, `canCancel`, and `pendingReason` to see what remains possible. Updates after dispatch also return `too_late`; a repeated cancellation returns `already_cancelled`.

This requires Pi 0.85.1 or newer, which supports dispatching session commands from extension tools.

### Fresh background agent sessions

Use `agent_new_session` for requested session changes or ongoing workflows with automatic handovers. Its tool instructions tell agents to complete ordinary tasks in the current session. A standing instruction to continue through handovers supports repeated use during that workflow.

A background agent calls the tool with a self-contained handover:

```json
{
  "handover": "Continue the asset review. The user requested an ongoing workflow with automatic handovers near 90% context usage. Reviewed sprites/terrain; findings are in build/asset-review.md. Next, inspect sprites/units and append findings. Preserve the existing file ownership assignments."
}
```

The parent can call the same tool with an `id` and `handover` to start a fresh conversation for that background agent. Include the task, user instructions, progress, decisions, relevant files, checks, and concrete next steps. Your existing workflow instructions determine when to hand over.

The agent stops its current tools, opens a fresh conversation, and starts working from the handover automatically. It keeps its agent ID, configuration, and pending messages; queued messages run after the handover. The new conversation loads project instructions and tools along with the handover. If an execution timeout is configured, each fresh session gets that duration; otherwise, it runs without a deadline.

`agent_status` reports the current `sessionFile`, `previousSessionFile`, and `sessionCount`. Previous transcripts remain saved, and each new transcript links to the preceding session. The agent stays active through the transition and reports completion after its work finishes.

## Completion sound

In interactive mode, VarisDev tracks terminal focus and raises an alert only when the terminal is unfocused as the `agent_settled` event fires. This waits until automatic retries and queued follow-up work have finished.

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

The image model is [GPT Image 2.5 Sunburst](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), pinned to `gpt-image-2.5-sunburst-2026-09-08` for generation and editing. The `quality` parameter accepts `auto`, `low`, `medium`, `high`, `xhigh`, and `max`, defaulting to `auto` when unspecified. The agent chooses quality from the user's requested detail, latency, and cost preferences.

Request dimensions through `size`, using `auto` or a `WIDTHxHEIGHT` string. Recommended sizes are `1024x1024`, `1536x1024`, and `1024x1536`. Custom dimensions must be multiples of 16, with an aspect ratio between 1:3 and 3:1, neither edge above 3840 pixels, and 655,360–8,294,400 total pixels. For transparent backgrounds, set `background: "transparent"` and use PNG or WebP output.

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
