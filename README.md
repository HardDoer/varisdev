# Varisware Pi/pidev plugins

Varisware VarisDev package.

## Included

- `extensions/varisdev.ts` — replaces the startup header with the three-color Varisware ASCII logo, keeps the tab/window title set to `VarisDev - <folder>`, uses a small crow image-style loader with animated processing dots while the assistant is streaming, raises a completion alert when the agent settles, and registers VarisDev tools.
- `src/tools/browse.ts` — agent-callable `browse` tool for compact HTTP/HTTPS browsing without dumping response headers or large body samples into the LLM context.
- `src/tools/download.ts` — agent-callable `download` tool for streaming HTTP/HTTPS responses to project files.
- `src/tools/elevenlabs.ts` — agent-callable `elevenlabs` tool for finding voices and generating speech or sound effects as local audio files.
- `src/tools/gamemaker-query.ts` — agent-callable `gamemaker_query` tool for inspecting, filtering, grouping, and sampling trailing-comma GameMaker `.yy` and `.yyp` files.
- `src/tools/image-query.ts` — agent-callable `image_query` tool for inspecting image metadata, transparency, visible bounds, and grid occupancy across files without one-off scripts.
- `src/image-previews.ts` and `src/image-preview/` — native image previews in the conversation, a terminal image viewer, and Sixel support for Windows Terminal.
- `src/tools/image-preview.ts` — agent-callable `image_preview` tool for showing an existing local image to the user.
- `src/tools/json-query.ts` — agent-callable `json_query` tool for inspecting, filtering, grouping, and sampling JSON files without one-off scripts.
- `src/tools/openai-image.ts` — agent-callable `openai_image` tool that creates or edits images with the OpenAI Images API and saves them to files.
- `src/tools/agents.ts` and `src/agents/` — background agent orchestration with spawning, progress, results, direct messages between agents, waiting, and cancellation.
- `src/commit.ts` — adds `/commit [instructions]` to delegate committing and pushing to Codex GPT-5.5 with xhigh effort and automatic worker cleanup.
- `themes/varisware.json` — Varisware phosphor-green terminal theme.

## Conversation compaction

VarisDev uses Pi's native compaction for parent and background agent sessions. Pi's compaction settings control automatic compaction and recovery from context overflow. Use `/compact` to compact the current conversation manually. Compaction keeps the current session and its background agents active.

## Agent orchestration

VarisDev can delegate work to background Pi agents while the parent continues working. Each agent has its own conversation and receives the project’s context files, skills, built-in coding tools, and VarisDev project tools. Agents accept any model from the parent’s model registry using `provider/model` format. The parent model is inherited by default; when no parent model is set, the default is `openai-codex/gpt-5.6-sol`. Workers use the parent’s credential registry and inherit its thinking level, with `xhigh` as the maximum. Include the relevant context in the task; the parent conversation is not copied. Workers also receive `agent_list` and `agent_send` to communicate directly with peers and the parent.

| Tool | Purpose |
| --- | --- |
| `agent_spawn` | Start an agent and immediately return its ID. |
| `agent_list` | List active agents and status counts; use `view: "history"` for finished agents or `view: "all"` for both. |
| `agent_status` | Read one agent’s latest result, error, and transcript paths. |
| `agent_inbox` | Read messages workers sent to the parent, newest first, or retrieve full text by message ID. |
| `agent_send` | Send instructions or replace selected pending messages with `supersedes`. Workers can also message `"parent"`. |
| `agent_messages` | List message previews or retrieve one full message by ID, including its current delivery state. |
| `agent_message_remove` | Remove selected pending messages while the active task continues. |
| `agent_wait` | Wait for any or all selected agents and collect their results. |
| `agent_cancel` | Cancel an agent and discard its pending messages. |

The `/commit` shortcut requests Codex GPT-5.5 with xhigh effort.

For example, call `agent_spawn` with:

```json
{
  "name": "reviewer",
  "task": "Review src/tools/browse.ts for response truncation bugs. Report findings with file and line references.",
  "instructions": "Inspect and report findings; leave fixes to the parent agent."
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

Worker messages automatically identify the sender by name and ID. Messages to peers enter the recipient’s follow-up queue. Messages to the parent are stored in `agent_inbox`; they never add prompts or trigger parent turns. The parent reads the inbox explicitly. Workers put their final result in their final answer, which the parent retrieves through `agent_status` or `agent_wait`. Communication tools are scoped to the parent session. Workers have `agent_list`, `agent_send`, `agent_messages`, and `agent_message_remove`; the parent also manages spawning, status, inbox access, waiting, and cancellation.

`agent_inbox` retains the latest 100 explicit worker messages, newest first. With no arguments it returns up to 10 previews of 500 characters with message IDs, sender names, and timestamps. Use `limit` (up to 20), `offset`, and `nextOffset` to browse, or `{"messageId":"<message ID>"}` to retrieve full text. Reading does not remove messages.

Four agents run concurrently; additional agents queue. An agent moves through `queued`, `running`, and `completed` or `failed`. Cancelling active work first reports `cancelling`, then `cancelled` when its tools stop. Follow-up messages run in order after the current task, retaining the conversation. Failed and cancelled agents require a new spawn.

Spawn options include `cwd` (relative to the parent directory), `model` (any registered model in `provider/model` format), `thinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`), `instructions`, `timeoutMs`, and `autoCleanup`. Runtime validation checks model availability and enforces the effort cap. Omitted model inherits the parent model or defaults to GPT-5.6-sol when no parent model is set; omitted thinking level inherits the parent's setting. Agents have no execution deadline by default. Set `timeoutMs` to impose a deadline of up to one hour, including initialization and pending follow-up messages. Queue time is excluded. When configured, the timeout starts afresh when a completed agent receives new work. Each parent session can hold 64 agents, with up to 32 pending messages per agent. Finished agents with `autoCleanup: true` do not count toward that limit.

Set `autoCleanup: true` for a task whose worker should be disposed after all queued work finishes. Cleanup also runs after failure or cancellation, once running tools have stopped. Results, transcript paths, and history stay available; a cleaned agent cannot accept new work. The default is `false`, allowing completed agents to resume.

Collect results with `agent_status` or `agent_wait`. Completion, failure, and cancellation update the agent's stored status without sending a parent message or triggering a turn. `agent_wait` defaults to all agents and a 60-second wait, capped at 120 seconds; `timeoutMs: 0` polls immediately. A wait timeout or interrupted wait leaves agents running. In `any` mode, an already finished agent satisfies the wait.

Agents share their selected working directory and can change its files. Assign file ownership in each task, or provide separate working directories for independent edits. The terminal footer shows active agent counts.

- `/agents` shows queued, running, and cancelling agents, with a hint when finished agents are available in history.
- `/agents history` shows completed, failed, and cancelled agents, newest first.
- `/agents all` shows active agents followed by history.
- `/agents cancel <id|all>` cancels work manually.

`agent_list` uses the same views and defaults to active agents. Its summary counts every status across the session, including agents outside the selected view. List entries include names, IDs, activity, pending message counts, and failure reasons; use `agent_status` for full results and transcript paths. Failures show their cause, such as `Missing credentials`. Finished agents stay available in history, and completed agents with `autoCleanup: false` return to the active view when sent new work.

Transcripts and the latest full result are saved under `~/.pi/agent/varisdev/agents/<parent-session-id>/<agent-id>/` (or the configured Pi agent directory). Tool output is bounded and includes `sessionFile` and `resultFile` paths for inspection with `read`. Quitting, reloading, starting or switching sessions, or forking cancels the current agents and disposes their conversations. Saved files remain available after shutdown.

### Commit and push

Use `/commit` to ask the current session to **commit and push** through a **Codex GPT-5.5** background agent (`openai-codex/gpt-5.5`) with **xhigh** effort. Add optional instructions after the command:

```text
/commit
/commit Only include the browse fix. Use the commit message "Fix browse truncation".
```

With no arguments, the task is the same as saying “commit and push.” Additional instructions refine that request. The current session supplies the relevant conversation context, change scope, and completed checks to `agent_spawn`, setting `model: "openai-codex/gpt-5.5"`, `thinkingLevel: "xhigh"`, and `autoCleanup: true`. If the parent is working, the request is queued as a follow-up.

The worker follows repository instructions, inspects changes, runs required checks, commits, and pushes. The parent collects its result and reports the outcome. The worker session is automatically disposed when the task finishes, fails, or is cancelled. Saved results and transcript paths can be inspected with `agent_status`; `/agents cancel <id>` cancels active work.

### Inspecting and revising agent queues

`agent_send` returns the new message ID, sender identity, creation time, and current state. Its optional `reference` associates the instruction with a task or artifact, such as an issue ID or file path. Initial task messages also have IDs and sender metadata.

Call `agent_messages` with `{"id":"<agent ID>"}` to inspect pending messages in delivery order. Each entry has a preview of up to 500 characters; `limit` defaults to 10 and is capped at 20. Use `offset` and `nextOffset` for subsequent pages. `view: "history"` shows delivered, removed, superseded, and discarded entries; `view: "all"` includes both pending entries and history. Retrieve the full text and latest state using `{"id":"<agent ID>","messageId":"<message ID>"}`. Message history remains available for the lifetime of the parent session.

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

## Native image previews

Images generated by `openai_image`, downloaded images, and images opened with `read` get previews directly in the interactive conversation. Local image links in assistant messages also create previews when the referenced files exist. Repeated references to an unchanged file are deduplicated.

- **Click a preview** to enlarge it inside the terminal.
- **`/images`** opens the most recent image; use the left/right arrows to browse and **Esc** to close.
- **`/images list`** selects an image from the current session.
- **`/images <path>`** opens a local file, including paths with spaces.
- The agent can call **`image_preview`** with `{"path":"screenshots/result.png"}` to explicitly show any existing image. Generation already creates previews automatically.

The plugin adds a Sixel renderer for **Windows Terminal 1.22 or newer**. It queries the terminal's graphics mode, reserves ordinary text cells in Pi's layout, and draws the corresponding image regions after Pi finishes each screen update. This handles both the regular terminal and fullscreen Pi interface without modifying the installed Pi packages. Terminal hooks are removed when the session shuts down or reloads, and each draw restores the cursor and graphics mode.

Pi's official image component handles Kitty and iTerm2 terminals. Other terminals get thumbnails made from true color text cells. Sharp is the library used to decode and resize images; the `sixel` library encodes the graphics sent to Windows Terminal. VarisDev runs Sharp in a separate Node process for each image operation, including `image_query` and `image_preview`, and waits for that process to exit before returning its result. This releases Sharp's native DLLs on Windows so they do not remain locked for the Pi session and block package updates. Cancellation and a 60 second timeout terminate the image process. The preview interface and larger viewer run inside pidev. Preview entries store file paths outside the model context, with no browser server or image copies on disk.

Supported formats are PNG, JPEG, GIF, WebP, AVIF, SVG, and TIFF. Animated and multipage files show their first frame/page. Transparent areas use a checkerboard in Sixel and text thumbnails. Preview decoding is limited to 50 MiB and 40 million pixels. Conversation image links are also converted to proper `file://` URLs for opening the original with the terminal's normal link action.

After updating this package, use **`/reload`** to load the preview support into an existing session. When upgrading from a version that loaded Sharp directly into Pi, close that Pi process once to release any DLLs it already loaded; `/reload` cannot unload native libraries.

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

## ElevenLabs audio tool

The `elevenlabs` tool is available to the main agent and background workers. Set the API key in the environment before starting Pi:

```bash
export ELEVENLABS_API_KEY="your-api-key"
```

In PowerShell:

```powershell
$env:ELEVENLABS_API_KEY = "your-api-key"
```

Find a voice with `list_voices`. Results include voice IDs, descriptions, labels, preview URLs, and pagination:

```json
{
  "action": "list_voices",
  "search": "narrator",
  "pageSize": 20
}
```

When `hasMore` is true, pass `nextPageToken` from the result with the same search to get the next page. Use a returned `voiceId` to generate spoken audio:

```json
{
  "action": "text_to_speech",
  "voiceId": "<voiceId from list_voices>",
  "text": "Welcome aboard. All systems are ready.",
  "filenamePrefix": "welcome",
  "voiceSettings": {
    "stability": 0.5,
    "similarityBoost": 0.75,
    "speed": 1
  }
}
```

Speech defaults to `eleven_multilingual_v2`. Set `modelId` to use another speech model. Optional speech controls include `languageCode` (when supported by the model), `seed`, and `voiceSettings` with `stability`, `similarityBoost`, `style`, `speed`, and `useSpeakerBoost`.

Generate a sound effect from a description:

```json
{
  "action": "sound_effects",
  "text": "Soft mechanical hum inside a spaceship, with occasional quiet electrical clicks",
  "durationSeconds": 8,
  "loop": true,
  "promptInfluence": 0.3,
  "filenamePrefix": "spaceship-ambience"
}
```

Sound effects use `eleven_text_to_sound_v2`. Duration can be 0.5–30 seconds; omit `durationSeconds` to let the model choose. `promptInfluence` ranges from 0 to 1, and `loop` requests a seamless loop.

Both generation actions save files under `generated-audio/` by default. Set `outputDir` to change the directory; relative paths resolve under the agent's working directory. Filenames include a sanitized prefix, timestamp, and random suffix. Results report the saved path, format, byte count, and request ID and character cost when returned by the API.

`outputFormat` defaults to `mp3_44100_128`. The tool also supports the API's other MP3, PCM, Opus, μ-law, and A-law formats; speech additionally supports WAV. PCM files contain raw samples without a WAV header. Format availability depends on the ElevenLabs subscription. `timeoutMs` covers the request and audio download, defaults to 300,000 ms, and accepts up to 600,000 ms. Failed or cancelled downloads remove incomplete files. Each call sends one generation request without automatic retries.

API references: [speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [sound effects](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert), [voices](https://elevenlabs.io/docs/api-reference/voices/search).

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
npm ci --include=optional
pi -e ./extensions/varisdev.ts
```

Sharp is loaded through Node only when an image is inspected or rendered. A missing image dependency reports an error in that image operation instead of preventing the entire plugin from starting.

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
