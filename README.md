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
- `src/session-handover.ts` — switches sessions for the handover workflow and provides handover status, update, and cancellation tools.
- `src/auto-handover.ts` and `src/handover-settings.ts` — request a handover from the working assistant at 80% context and optionally continue the plan in a fresh session.
- `themes/varisware.json` — Varisware phosphor-green terminal theme.

## Automatic handovers

VarisDev automates **plan → implementation → handover → fresh session → continue the plan**. Both automation switches default to `on`:

- **`auto-handover`**: when context usage reaches **80% or higher**, the harness sends the working assistant a handover instruction after the current tool batch finishes. It requests one handover per conversation, with another opportunity after native fallback compaction.
- **`auto-session-refresh`**: when the assistant finishes writing the handover, the harness starts a fresh session using that final response and tells it to continue the plan.

The working agent prepares the handover using its current understanding and normal tools. It can update the plan, inspect project files and record verified progress. The prompt asks for the remaining plan or its saved path, completed work, decisions, file references, check results, remaining uncertainties, and precise next steps. It explicitly distinguishes conversation reports, current file evidence, and unverified claims.

Only a completed final response to the handover instruction is accepted. Tool calls, interrupted responses, errors, and truncated responses do not start a fresh session. A new user instruction supersedes a handover being drafted or waiting to switch sessions. The agent is asked to finish with handover text; the harness schedules the session change after that turn settles.

The destination receives the handover and normal system/project instructions. Model selection, thinking level, and active tools carry over. Each refresh creates a new session ID and transcript. Previous messages and tool outputs remain in the old transcript on disk.

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

The switches are independent. Disabling automatic prompts still allows a manually requested handover to start a fresh session when automatic refresh is on. Changes to the refresh setting apply when the handover finishes; enabling it does not immediately consume an existing draft.

### Manual steps

- **`/handover`** asks the working assistant to prepare a handover now, at any context usage.
- **`/handover continue`** starts a fresh session from the most recent completed draft.

With both switches off, use those two commands to control each step. Completed drafts survive reloads and session resumes; new work invalidates an older draft. An interrupted handover can be requested again with `/handover`.

Automatic native threshold compaction is held while the enabled handover workflow approaches 80% and while a handover is being prepared. This prevents Pi's fixed token reserve from compacting early on smaller models. Manual `/compact` and overflow recovery remain available. If preparation fails or is interrupted, native compaction can handle the existing conversation.

### Managing handovers

| Tool | Purpose |
| --- | --- |
| `session_handover_status` | Inspect a handover by ID or list recent requests and their delivery states. |
| `session_handover_update` | Replace handover text before dispatch and increment its revision. |
| `session_handover_cancel` | Cancel a handover before session replacement begins. |

Inspect requests using `session_handover_status` with `{"id":"<request ID>"}`; omit `id` to list recent requests with previews. The latest 50 requests remain available across handovers in the running application.

States progress through `scheduled`, `waiting_for_idle`, and `switching`, then `completed`, `cancelled`, or `failed`. Completion confirms that the destination received the handover prompt and reports its `deliveredRevision`.

Call `session_handover_update` with `id` and the complete replacement `handover` to revise a pending request. Each update increments `revision`. Updates are accepted until prompt dispatch, including during session replacement.

Call `session_handover_cancel` with `id` before replacement begins. Once `switching` starts, the host may have disposed the source and cancellation returns `too_late`.

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
