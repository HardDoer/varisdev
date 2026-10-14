# VarisDev

A desktop coding app with parent sessions, background agents, and extensible tools.

## Install and start

Install [Node.js 24 or newer](https://nodejs.org/) and Git, then:

```sh
npm install -g git+https://github.com/HardDoer/varisdev.git
varisdev login
varisdev
```

`varisdev` opens the current folder. Use `varisdev /path/to/project` to open another folder, or **Open folder** in the app. Existing model accounts, settings, plugins, and saved conversations are reused. Installation downloads the Electron desktop executable, includes the session runtime, and builds the app automatically. The first launch requires no additional runtime download.

On macOS, `varisdev app install` also adds **VarisDev** to `~/Applications`, ready for Finder, Spotlight, and the Dock.

## Updates

Use **Updates → Check for updates**, click **Updates available** at the top of the app, or run:

```sh
varisdev update
```

`varisdev update --check` checks without installing. Updates prepare and verify a new runtime before activating it. A failed installation leaves the working runtime in place. Choose **Restart to finish update** once parent sessions and agents are idle. Preferences and saved conversations survive updates.

## Accounts and plugins

```sh
varisdev login openai-codex
varisdev login anthropic --api-key
varisdev logout openai-codex
varisdev install npm:example-plugin
varisdev install git:github.com/owner/plugin --local
varisdev list
varisdev plugins update
varisdev remove npm:example-plugin
```

Run `varisdev login` to see available accounts. Plugins use the existing extension, skill, prompt, and theme formats. **Model & settings → Reload resources** reloads them in an idle conversation. Plugins can also add [conversation visuals and app themes](docs/plugins.md); the [project board example](examples/project-board/) includes both. `varisdev run [options]` runs prompts and automation from the terminal. `varisdev --help` lists the commands.

## Included

- `extensions/varisdev.ts` — replaces the startup header with the three-color Varisware ASCII logo, keeps the tab/window title set to `VarisDev - <folder>`, uses a small crow image-style loader with animated processing dots while the assistant is streaming, raises a completion alert when the agent settles, and registers VarisDev tools.
- `src/tools/browse.ts` — agent-callable `browse` tool for compact HTTP/HTTPS browsing without dumping response headers or large body samples into the LLM context.
- `src/tools/download.ts` — agent-callable `download` tool for streaming HTTP/HTTPS responses to project files.
- `src/tools/elevenlabs.ts` — agent-callable `elevenlabs` tool for finding voices and generating speech or sound effects as local audio files.
- `src/tools/gamemaker-query.ts` — agent-callable `gamemaker_query` tool for inspecting, filtering, grouping, and sampling trailing-comma GameMaker `.yy` and `.yyp` files.
- `src/tools/image-query.ts` — agent-callable `image_query` tool for inspecting image metadata, transparency, visible bounds, and grid occupancy across files without one-off scripts.
- `src/conversation-images.ts` and `assets/dashboard/visualizations.js` — inline conversation images, a larger viewer, and plugin visuals.
- `src/tools/image-preview.ts` — agent-callable `image_preview` tool for showing an existing local image to the user.
- `src/tools/json-query.ts` — agent-callable `json_query` tool for inspecting, filtering, grouping, and sampling JSON files without one-off scripts.
- `src/tools/openai-image.ts` — agent-callable `openai_image` tool that creates or edits images with the OpenAI Images API and saves them to files.
- `src/tools/agents.ts` and `src/agents/` — background agent orchestration with spawning, progress, results, direct messages between agents, waiting, and cancellation.
- `src/commit.ts` — adds `/commit [instructions]` to delegate committing and pushing to Codex GPT-5.5 with xhigh effort and automatic agent cleanup.
- `src/desktop/`, `src/dashboard/`, and `assets/dashboard/` — a desktop factory view of parent sessions and agents, with 3D robots, task effects, and file changes.
- `themes/varisware.json` — Varisware phosphor-green terminal theme.

## Desktop factory app

The app owns its conversations and agents, so you can close the launching terminal. Reopening VarisDev focuses the existing window; opening another folder adds its parent session.

Use **Open folder** to choose a project and start an idle conversation. No initial prompt is required. The picker remembers your last project. Accounts, model settings, project context, and session storage are read from their existing locations.

Each parent session has a factory view, with robots representing the parent session and its agents. Working agents stay visible automatically, with bright floor rings, stronger movement, and a visible Working marker. Labels show their task and current action. Dispatch beams and sparks follow actual starts and completions. The session overview shows the other parent sessions and their activity, so work in another folder stays visible too.

Select a parent session or agent to inspect its task, model, folder, elapsed time, response, errors, and saved result paths. The activity feed follows session events, tools, agent messages, and status changes. Click an event to inspect its inputs, output, errors, agent result, or file diff. The robot representing the parent session has distinct thinking, writing, and tool use animations and a closer view when working alone. The motion control and system reduced-motion setting disable animation; a graphical fallback is available without WebGL. Occasionally the parent robot cracks a whip toward a working agent, which reacts briefly. This is a visual effect and does not change agent work.

While a parent session is idle, its robot rests for a random 15–60 seconds before each walk, then randomly picks one of twelve activities: drinking coffee, jumping rope, juggling, dancing, stretching, lifting weights, using a hula hoop, playing with a yo-yo, reading, sweeping, balancing, and throwing a paper plane. It pauses wherever it finished before wandering again. A new prompt makes it jump in surprise and run back to its workstation while the session starts work. Motion off and reduced motion keep it stationary.

The conversation shows user prompts, streaming replies, and live tool calls with their inputs, progress, results, and errors. Click an agent’s robot or card to open its own conversation with the same message and tool views. Switching conversations scrolls to the latest message. Expanded tool details and recent agent conversations remain available after an agent finishes. **Back to parent session** returns to the coordinator’s conversation. **Parent session** and **Agent conversation** labels and distinct header accents identify the current view. Headers, tabs, and panel positions remain stable when switching. The prompt box and parent controls appear in the parent session view; the agent view shows its task in the same dock. Assistant replies use a brighter background, a strong accent border, and larger text. File reads, file changes, commands, agents, web requests, and media actions have named labels and distinct accents. Outputs start expanded. The conversation provides the vertical scrolling for long outputs, and you can deliberately collapse individual items. The Live feed uses a compact layout. The **Menu** at the right holds Zoom, Theme, Motion, and Open folder, leaving more room for the conversation. The factory view, parent selector, active agents, and history stay within the window. Long lists scroll inside their sections, and the conversation scrolls above the composer.

**Skills & commands** lists the current project's skills, prompt templates, extension commands, and available tools. Search the list or type `/` in the composer for suggestions; Enter or Tab inserts a command, then add any arguments and send it. Skills and templates use the runtime's normal expansion. Configured project and user extensions load in the desktop runtime.

**Model & settings** changes the model and thinking level during active work or while idle. Changes apply to subsequent model calls. Compaction and reloading skills, templates, and extensions require an idle session. Extension selections, confirmations, inputs, and editors appear as dialogs in the app. Extension notifications remain in Conversation until dismissed. Custom terminal dialogs render inside the GUI and receive keyboard input there. Extensions that supply an editor or autocomplete provider expose an **Extension editor** button. It opens their editor with your draft and returns submitted text to the composer.

**Context files** opens the selected parent session’s Markdown context files, their paths, and how they are used. Expand a file to preview its loaded text. Open or edit files from Context or recorded changes, and pin them in the Markdown window. Drag the window to place it, resize it, or lock its position. Open files refresh as agents and parent sessions edit them, with a visible update cue. Unsaved edits are preserved, and saving checks for changes made on disk. Reload session resources to apply edits to automatically loaded instruction files.

**Tokens** shows context occupancy separately from cumulative recorded model usage: input, output, cache reads, cache writes, and estimated cost by response. Set an optional token target to visualize progress; it does not stop a run. Model usage comes from saved assistant usage records and configured model rates. Tool execution and UI actions add no model tokens themselves; tool results can consume input tokens on later calls. Individual files, skills, and tool results do not have exact token counts in provider reports. Choose the parent or an individual agent in the usage selector. Each has separate totals that remain available after its run finishes. Recorded compaction summaries also count; one summary row can combine several model calls. Failed compaction attempts do not expose usage. Image and audio services have separate billing.

The composer stays at the bottom of the conversation. **Terminal ↗** opens an available system terminal in the selected project folder. **Prompt** returns focus to the message field. The composer supports normal cursor editing, selection, undo, and paste. **Enter sends; Shift+Enter inserts a new line.** Drag the prompt field’s resize handle or expand the editor for longer prompts. Each parent keeps its own draft and cursor position as you switch between sessions. During active work, the send button becomes **Steer**. The parent session applies all available steering together after the current turn’s tool calls, before the next model call. Steering instructions remain visible above the composer until applied. A small data trail flies from the prompt field to the parent robot when a prompt enters processing, including when queued steering is applied. **Esc** or **Stop** stops only the parent session and moves pending steering back into the prompt field, preserving your draft. Its running and queued agents continue. Select an agent and choose **Cancel agent** to stop it, or use **Cancel all agents** above the active agents. Dialogs handle Esc within their own interaction. Thinking, writing, and tool execution have distinct activity indicators. Stopping the parent makes its robot jump in surprise, throw up its arms, and settle as a brief red alert lights the factory. Motion off and reduced motion use a static startled pose and alert.

**Zoom** scales the whole interface, including Skills & commands and the expanded editor. The setting is saved across restarts; changes through the View menu and its zoom shortcuts are saved too. Interface text uses a shared 16 px base with larger metadata and controls.

Choose a palette from **Menu → Theme**: Factory, Nord, Dracula, Catppuccin Mocha, Solarized Light, High Contrast, or a theme supplied by an installed plugin. The choice applies to the interface and the 3D factory and is saved locally. Text contrast, visible keyboard focus, and named status labels keep the interface readable. The app uses a bold robot crow icon with native Windows taskbar sizes. Regenerate its PNG, ICO, and ICNS assets from the SVG with `node scripts/build-icon.mjs`.

**Changes** shows successful `edit` and `write` operations attributed to the parent session or agent that made them, with file paths and bounded diffs. Tracking begins when the extension loads. The dashboard retains the latest 100 change records and 160 activity events per parent session. **Workspace diff** reads current Git changes, including staged, unstaged, and untracked files. This folder view can include earlier changes and shell commands from any parent session or agent sharing that folder. It refreshes on request. File changes tracked through the tools also work outside Git repositories.

Each new session creates an independent parent conversation with that folder's project context, coding tools, VarisDev tools, and its own agent team. You can run up to eight parents, steer active work, and stop their work from the app. Stopping a parent returns pending steering to its prompt field while its agents continue. Closing a parent session cancels its agents. When opened with `/factory`, the connected terminal conversation can also be controlled from the GUI.

Opening the app from Finder starts with an overview. `varisdev` opens the current project. Visual effects follow actual work.

Graphics load from local files. Closing the app stops its parent sessions and agents. Conversations are saved, while activity and change previews are kept in memory for the current runtime. Preferences and cache live outside the installed package in the VarisDev application data folder.

### Storage and environment

Runtime updates and desktop preferences use:

- macOS: `~/Library/Application Support/VarisDev/`
- Windows: `%LOCALAPPDATA%/VarisDev/`
- Linux: `$XDG_DATA_HOME/varisdev/`, or `~/.local/share/varisdev/`

Set `VARISDEV_DATA_DIR` to choose another location. The desktop profile lives in its `desktop` subdirectory. Account and conversation storage continues to use `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when configured.

`varisdev update` updates the bundled session runtime. To install new VarisDev application code from GitHub, repeat the installation command and restart the app. After reinstalling the application or moving it, run `varisdev app install` again if you use the macOS launcher. Removing `~/Applications/VarisDev.app` removes that launcher; saved conversations remain.

The installer saves your current executable search path so tools such as Node and Git remain available when opened from Finder. It also preserves `PI_CODING_AGENT_DIR` if set during installation. Shell startup files are not loaded. For additional environment settings such as `OPENAI_API_KEY` or `ELEVENLABS_API_KEY`, create `~/Library/Application Support/VarisDev/environment.json` containing a JSON object of string values, then restart the app. For example:

```json
{
  "ELEVENLABS_API_KEY": "your-api-key"
}
```

Saved model login credentials are read from the account storage directly. Environment settings in this file override the launch environment.

## Conversation compaction

VarisDev uses the runtime's native compaction for parent and background agent sessions. Compaction settings control automatic compaction and recovery from context overflow. Use `/compact` to compact the current conversation manually. Compaction keeps the current session and its background agents active.

## Agent orchestration

VarisDev can delegate work to background agents while the parent continues working. Each agent has its own conversation and receives the project’s context files, skills, built-in coding tools, and VarisDev project tools. Agents accept any model from the parent’s model registry using `provider/model` format. The parent model is inherited by default; when no parent model is set, the default is `openai-codex/gpt-5.6-sol`. Agents use the parent’s credential registry and inherit its thinking level, with `xhigh` as the maximum. Include the relevant context in the task; the parent conversation is not copied. Agents also receive `agent_list` and `agent_send` to communicate directly with peers and the parent.

| Tool           | Purpose                                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `agent_spawn`  | Start an agent and immediately return its ID.                                                              |
| `agent_list`   | List active agents and status counts; use `view: "history"` for finished agents or `view: "all"` for both. |
| `agent_status` | Read one agent’s latest result, error, and transcript paths.                                               |
| `agent_inbox`  | Read messages agents sent to the parent, newest first, or retrieve full text by message ID.                |
| `agent_send`   | Steer active work or resume a completed agent. Agents can also message `"parent"`.                         |
| `agent_wait`   | Wait for any or all selected agents and collect their results.                                             |
| `agent_cancel` | Cancel an agent and clear its steering messages.                                                           |

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

Agents use `agent_list` to discover peers by name and ID in the same parent session. Their list also includes `selfId`, and their system instructions include their own ID. A agent can call `agent_send` with a peer’s ID using the example above, or send a progress update or question directly to the parent:

```json
{
  "id": "parent",
  "message": "The asset dimensions are confirmed. Please use a 32-pixel grid."
}
```

Agent messages automatically identify the sender by name and ID. Messages to peers use native steering during active work. Messages to the parent are stored in `agent_inbox`; they never add prompts or trigger parent turns. The parent reads the inbox explicitly. Agents put their final result in their final answer, which the parent retrieves through `agent_status` or `agent_wait`. Communication tools are scoped to the parent session. Agents have `agent_list` and `agent_send`; the parent also manages spawning, status, inbox access, waiting, and cancellation.

`agent_inbox` retains the latest 100 explicit agent messages, newest first. With no arguments it returns up to 10 previews of 500 characters with message IDs, sender names, and timestamps. Use `limit` (up to 20), `offset`, and `nextOffset` to browse, or `{"messageId":"<message ID>"}` to retrieve full text. Reading does not remove messages.

Six agents run concurrently, matching the six seats; additional agents queue. An agent moves through `queued`, `running`, and `completed` or `failed`. Cancelling active work first reports `cancelling`, then `cancelled` when its tools stop. Messages sent during active work steer the next model turn after the current assistant turn’s tool calls. Completed agents resume with the same conversation. Failed and cancelled agents require a new spawn.

Spawn options include `cwd` (relative to the parent directory), `model` (any registered model in `provider/model` format), `thinkingLevel` (`off`, `minimal`, `low`, `medium`, `high`, or `xhigh`), `instructions`, `timeoutMs`, and `autoCleanup`. Runtime validation checks model availability and enforces the effort cap. Omitted model inherits the parent model or defaults to GPT-5.6-sol when no parent model is set; omitted thinking level inherits the parent's setting. Agents have no execution deadline by default. Set `timeoutMs` to impose a deadline of up to one hour, including initialization and work directed by steering messages. Queue time is excluded. When configured, the timeout starts afresh when a completed agent receives new work. Each parent session can hold 64 agents. Finished agents with `autoCleanup: true` do not count toward that limit.

Set `autoCleanup: true` for a task whose agent should be disposed after its work finishes. Cleanup also runs after failure or cancellation, once running tools have stopped. Results, transcript paths, and history stay available; a cleaned agent cannot accept new work. The default is `false`, allowing completed agents to resume.

Collect results with `agent_status` or `agent_wait`. Completion, failure, and cancellation update the agent's stored status without sending a parent message or triggering a turn. `agent_wait` defaults to all agents and a 60-second wait, capped at 120 seconds; `timeoutMs: 0` polls immediately. A wait timeout or interrupted wait leaves agents running. In `any` mode, an already finished agent satisfies the wait.

Agents share their selected working directory and can change its files. Assign file ownership in each task, or provide separate working directories for independent edits. The terminal footer shows active agent counts.

- `/agents` shows queued, running, and cancelling agents, with a hint when finished agents are available in history.
- `/agents history` shows completed, failed, and cancelled agents, newest first.
- `/agents all` shows active agents followed by history.
- `/agents cancel <id|all>` cancels work manually.

`agent_list` uses the same views and defaults to active agents. Its summary counts every status across the session, including agents outside the selected view. List entries include names, IDs, activity and failure reasons; use `agent_status` for full results and transcript paths. Failures show their cause, such as `Missing credentials`. Finished agents stay available in history, and completed agents with `autoCleanup: false` return to the active view when sent new work.

Transcripts and the latest full result are saved under `~/.pi/agent/varisdev/agents/<parent-session-id>/<agent-id>/` (or the configured Pi agent directory). Tool output is bounded and includes `sessionFile` and `resultFile` paths for inspection with `read`. Quitting, reloading, starting or switching sessions, or forking cancels the current agents and disposes their conversations. Saved files remain available after shutdown.

### Commit and push

Use `/commit` to ask the current session to **commit and push** through a **Codex GPT-5.5** background agent (`openai-codex/gpt-5.5`) with **xhigh** effort. Add optional instructions after the command:

```text
/commit
/commit Only include the browse fix. Use the commit message "Fix browse truncation".
```

With no arguments, the task is the same as saying “commit and push.” Additional instructions refine that request. The current session supplies the relevant conversation context, change scope, and completed checks to `agent_spawn`, setting `model: "openai-codex/gpt-5.5"`, `thinkingLevel: "xhigh"`, and `autoCleanup: true`. If the parent is working, the request uses native steering.

The agent follows repository instructions, inspects changes, runs required checks, commits, and pushes. The parent collects its result and reports the outcome. The agent session is automatically disposed when the task finishes, fails, or is cancelled. Saved results and transcript paths can be inspected with `agent_status`; `/agents cancel <id>` cancels active work.

## Completion sound

In interactive mode, VarisDev tracks terminal focus and raises an alert only when the terminal is unfocused as the `agent_settled` event fires. This waits until automatic retries and steering have finished.

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
  "groupBy": ["properties.owner_id"],
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
  "groupBy": ["parent.path"],
  "select": ["name", "spriteId.name"],
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

## Conversation images

Image attachments, images opened with `read`, and `openai_image` results appear directly in parent and agent conversations. Call **`image_preview`** with `{"path":"screenshots/result.png"}` to show an existing local image in VarisDev. Generated images appear automatically.

Click a thumbnail for a larger view. **Esc** closes that view; the parent keeps working. Loading errors include a retry control. Images load as they approach the visible conversation, and switching conversations clears the previous viewer.

Supported formats are PNG, JPEG, GIF, WebP, AVIF, SVG, and TIFF. Animated and multipage files show their first frame or page. SVG is rasterized before display. Decoding is limited to 50 MiB and 40 million pixels, with bounded reference and image caches. Snapshots carry image references, and the app loads raster data on demand. Sharp runs in a separate process so native image libraries are released after each operation.

Plugins can return image, Markdown, and progress blocks with their tool results or displayed messages. See [plugin visuals and themes](docs/plugins.md) for the format, optional helpers, and a working example.

## OpenAI image tool

Configure the API key through the environment before starting VarisDev:

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

The `elevenlabs` tool is available to parent sessions and agents. Set the API key in the environment before starting VarisDev:

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and isolated testing. This repo targets Node.js 24+ and uses Google's TypeScript Style via `gts`.

```bash
npm run lint
npm run typecheck
npm test
npm run fix
```

### Runtime and extension development

VarisDev uses Pi internally. The SDK is bundled in `desktop/node_modules`, independent of any globally installed command. Updates install a candidate SDK in a separate runtime directory, compile the app against it, and verify its imports before switching an atomic pointer. Running sessions retain their original runtime until restart. Failed updates do not replace it.

The root package declares the host SDK modules as peers for extension loading. Electron and the command use the separately installed SDK. Production dependencies include the compiler and package manager, and installation compiles `desktop/build` automatically. Runtime generations share the base application's non-SDK dependencies. Changing the base application invalidates generations built from older source.

For development:

```sh
npm ci
npm run desktop:build
node bin/varisdev.mjs
npm run desktop:dev
```

Use a temporary `PI_CODING_AGENT_DIR` and `VARISDEV_DATA_DIR` for integration checks. Production installation tests run outside the checkout and verify runtime dependencies, assets, automatic builds, plugin loading, and desktop startup.

VarisDev can also be loaded as a Pi extension with `pi install git:github.com/HardDoer/varisdev`. Interactive startup transfers the current conversation, model, tools, CLI options, and initial prompts to the app. Print, JSON, and RPC runs remain headless. Extension users update that package through `pi update` and restart Pi. Keep its GitHub registration rather than replacing it with a development folder.

Sharp is loaded only when an image is inspected or rendered. A missing image dependency reports an error in that operation.
