# VarisDev agents and tools

[Back to VarisDev](../README.md)

This page covers VarisDev's additions. See [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) for the underlying runtime.

## Agents

Every workspace session has exactly one fixed **Main agent**. It starts the session and does not use an agent configuration. Main stays available for the lifetime of the workspace and cannot be closed separately. Additional agents keep their configured Primary agent or Subagent roles.

Each additional agent has its own conversation and shares its workspace directory. It inherits the current agent's model and thinking level unless explicitly configured. Without a current model, `agent_spawn` requires a model choice.

**Menu → Agent settings** controls model choices for configurations without a model pin, including inherited models. The tool shows the configured choices to the current agent and checks them when agents start or resume. See [model configuration](configuration.md#agent-settings) and [agent configurations](agents.md).

| Tool              | Purpose                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `agent_spawn`     | Start an agent, return its ID, and deliver its result or error automatically.            |
| `agent_list`      | List active agents, history, or both.                                                    |
| `agent_status`    | Deferred explicit inspection of progress, results, metadata, and transcript paths.       |
| `agent_send`      | Message running work or resume a finished agent.                                         |
| `agent_inbox`     | Read explicit messages sent to the conversation's starting agent.                        |
| `agent_wait`      | Deferred explicit wait for selected agents; automatic delivery normally handles results. |
| `agent_cancel`    | Cancel an agent and its queued messages.                                                 |
| `agent_templates` | List, read, save, or delete scoped Markdown agent configurations.                        |

`agent_spawn` requires `task`. It automatically selects Default when `template` is omitted; `name` is optional. A spawned configuration must use `subagent` or `all` mode. Hidden configurations can be referenced directly; disabled configurations cannot be launched. Optional fields include `instructions`, `context` (`workspace` or `task`), `cwd`, `model` (`provider/model`), `thinkingLevel`, and `autoCleanup`. A configuration's model pin takes precedence over `model`. Other explicit spawn values refine the resolved configuration, while omitted model and thinking values inherit from the calling agent when the configuration does not set them.

In the workspace conversation, start a message with `@configuration-id task` to launch that configuration directly, for example `@review Check the changes in src/`. For a nested configuration ID, use `@agent:quality/review task`. Typing `@` offers visible, enabled `subagent` and `all` configurations allowed by the parent. The launch uses the current working directory and the same configuration model pins, permissions, and approval rules as `agent_spawn`. Each mention creates a new delegated conversation; retained subagents receive follow-up work through the parent agent. Only a leading, known configuration ID followed by a task invokes an agent; file mentions, email addresses, and unknown IDs remain ordinary input.

Agent configurations are optional. `agent_templates` is available through Pi's `tool_search`; listing uses `offset` and `limit` with a default of 20 entries and returns `nextOffset` when more remain. Configuration bodies are returned only by `get`.

Configuration permissions apply to the conversation created from that profile. The calling agent's `subagent` permission also controls which configured agents it may launch. See [agent configurations](agents.md) for scope merging, modes, defaults, and Markdown fields.

VarisDev automatically delivers the completed result or error from each spawned agent, and from each finished agent resumed with `agent_send`, to the conversation that initiated the work. The caller and workers continue in parallel. VarisDev waits only if the caller reaches the end of its run while tracked work is outstanding, then resumes it with the delivered result. An agent waiting for nested agents temporarily releases its concurrency slot. Sending with `agent_send` to an already running recipient is messaging only and does not add another result dependency.

`agent_status` and `agent_wait` remain available as deferred tools for explicit inspection and compatibility. Normal model runs do not need to poll or wait manually. Use `details: true` with `agent_status` for metadata and transcript paths. For an explicit wait, `agent_wait` uses a 60-second timeout and selects all agents, including history, when `ids` is omitted; a timeout leaves agents running. Pass specific IDs to avoid repeating older results. For successive `mode: "any"` waits, pass only unfinished IDs. Agents have no execution deadline.

The default concurrency limit is six agents per workspace, including Main; additional agents queue. Change **Menu → Agent settings → Maximum concurrent agents** to adjust the limit. A limit of one disables additional launches and resumptions. There is no fixed count limit on queued agents.

Finished history for completed, failed, and cancelled agents expires after the inactivity period in Agent settings. The default is seven days, with a range of 1–365 days. Viewing an agent's conversation, reading its result, or continuing it resets the period. Active agents, including running and queued work, the Main session transcript, and the last Primary agent's history are protected. Expired history is permanently deleted rather than archived. `autoCleanup: true` disposes a finished agent so it cannot resume; its result remains readable until history expires.

`agent_inbox` is for explicit agent-to-agent messages rather than automatic completion results. Start with `after: 0`, then reuse its `nextAfter` cursor to read new messages in arrival order. `hasMore` indicates another page; `missed` reports messages lost beyond the 100-message retention window. Cursors belong to the current workspace. Without `after`, inbox reads use newest-first history with `offset`. Use `messageId` to read a full message. Messages do not start a new turn in the receiving conversation.

Spawn, send, and cancel return short acknowledgements. Automatic delivery includes completed results and errors. Explicit status and wait calls return results; truncated output includes `outputTruncated` and `resultFile` for reading the full text.

When the workspace conversation finishes a run, VarisDev plays a completion sound only while the app window is unfocused. It waits for retries, automatic compaction, and queued work to settle. Cancelled runs stay silent. Windows and Linux use the original Windows 98 ding, with a system bell fallback; macOS uses its system bell.

Closing the window hides VarisDev in the system tray while work continues. Hover over its tray icon to see workspace names and their status, or right-click for **Open VarisDev** and **Quit VarisDev**. The tray menu also shows status for desktops without hover tooltips.

**Stop** stops the selected agent's current work; other agents continue. Open **Actions** beside the conversation title to cancel or remove an additional agent, or cancel all agents in the selected workspace. You can also right-click a workspace, agent, history entry, or the conversation title; the menu selects that item and supports keyboard navigation.

Right-click a workspace tile and choose **Rename workspace**, or use **Actions → Rename workspace**. The name is saved with the conversation and restored when resumed.

Choose **Actions → Close agent** to close an additional agent's conversation. Main remains available after all additional agents are closed. **Close workspace** ends the session, stops its agents, and closes its embedded terminals. Retained history remains available through **Menu → Resume session**. Closing the last workspace returns to the start screen, where **Recent projects** offers one-click access to your last twelve project folders. A workspace attached from another terminal is dismissed from this window.

Resuming a saved conversation replaces other open workspaces in the same folder, stopping their agents; workspaces in other folders stay open. If the chosen conversation is already open, its workspace is reused rather than duplicated. If it cannot be loaded, the current workspaces stay open.

If WebGL is unavailable, the factory uses an animated 2D scene with robot activity, agent selection, and theme colors.

Each workspace factory has a stable, theme-aware color and architectural variation. Idle conversation robots can visit other idle factories, then hurry back when prompted or when their workspace starts working. Visiting robots react to hits and recover before continuing their trip. **Menu → Appearance → Motion** (and your system's reduced-motion preference) controls these animations.

In **Menu → Appearance → Weapons**, choose **Cane** to swing at robots by waving the mouse, **Gun** to aim and click to shoot, or **Flamethrower** to spray flames while holding the left mouse button. Burning robots scream and run around; sustained flames leave a charred wreck for the cleaner. Right-click or press **Esc** to put away a weapon.

The weapons also damage scenery: the cane leaves dents, gunshots leave bullet holes and chips, and flames scorch and ignite nearby objects. Up to three repair robots work at a time, arriving after a delay to extinguish fires and restore damaged areas. In Year1998, shots mark the wall or furniture surface they strike, and repair and cleanup drones descend from above the office. Cleanup drones lift wrecks out of view. These effects do not interrupt agent work.

## Browsing and files

Scroll up in a conversation to read its full history, including after resuming a saved session. Tool entries expand to show their inputs and results. **Follow** returns to the latest messages as they arrive.

The selected agent's header shows its model, status, effort level, context usage, and a **Markdown files** button for the workspace. These remain accessible when the visualization is hidden.

In conversations, click file links or filenames in inline code, such as `src/main.js`, to open them; relative paths use the selected workspace. Markdown files open in VarisDev's editor, other files use their default application, and HTTP(S) links open in your browser.

| Tool              | Purpose                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `browse`          | Read web pages, links, raw text, or selected JSON fields.          |
| `download`        | Save a URL to a project file.                                      |
| `json_query`      | Filter, group, and sample JSON files.                              |
| `gamemaker_query` | Query GameMaker `.yy` and `.yyp` files, including trailing commas. |
| `image_query`     | Inspect image dimensions, alpha bounds, and grid occupancy.        |
| `image_preview`   | Display a local image in the conversation.                         |

`browse` supports `auto`, `links`, `raw`, and `none` views. Use `jsonPointers` to select fields from large JSON responses.

The query tools accept paths or globs. JSON fields support dotted paths and RFC 6901 JSON Pointers. Common options include `collectionPath`, `where`, `groupBy`, `select`, and `sampleLimit`.

When query output is truncated, the full result is saved in the project's `.varisdev/tool-output/` directory. These files remain available to saved conversations; delete them when you no longer need those results.

```json
{
  "path": "data/*.json",
  "collectionPath": "items",
  "where": {"status": "open"},
  "groupBy": ["owner"],
  "sampleLimit": 5
}
```

## Doctor

Run `/skill:doctor` for a setup checkup covering installation health, settings, extensions and their context cost, instruction quality, permissions, and session usage. It presents findings and concrete proposed fixes, then asks which changes to apply. Usage checks use VarisDev's session tokens and context information across providers; subscription-plan checks are excluded.

Run `/skill:doctor prompt-audit` for a focused audit of repository instructions, skills, and related configuration. It checks for conflicting rules, stale paths and commands, duplication, and unclear working conventions against the project's files and automation. Add a directory, file, or workflow to focus either mode.
