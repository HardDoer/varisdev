# VarisDev agents and tools

[Back to VarisDev](../README.md)

This page covers VarisDev's additions. See [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) for the underlying runtime.

## Agents

Each agent has its own conversation and shares its workspace directory. It inherits the current agent's model and thinking level unless explicitly configured. Without a current model, `agent_spawn` requires a model choice.

The **Agent models** section in **Menu → Tool models** controls model choices for configurations without a model pin, including inherited models. The tool shows the configured choices to the current agent and checks them when agents start or resume. See [model configuration](configuration.md#agent-models) and [agent configurations](agents.md).

| Tool              | Purpose                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `agent_spawn`     | Start an agent and return its ID.                                                |
| `agent_list`      | List active agents, history, or both.                                            |
| `agent_status`    | Read progress or results; use `details: true` for metadata and transcript paths. |
| `agent_send`      | Steer active work or resume a completed agent.                                   |
| `agent_inbox`     | Read messages sent to the workspace's main agent.                                |
| `agent_wait`      | Wait for selected agents to finish.                                              |
| `agent_cancel`    | Cancel an agent and its queued messages.                                         |
| `agent_templates` | List, read, save, or delete scoped Markdown agent configurations.                |

`agent_spawn` requires `task`. It automatically selects Default when `template` is omitted; `name` is optional. A spawned configuration must use `subagent` or `all` mode. Hidden configurations can be referenced directly; disabled configurations cannot be launched. Optional fields include `instructions`, `context` (`workspace` or `task`), `cwd`, `model` (`provider/model`), `thinkingLevel`, `timeoutMs`, and `autoCleanup`. A configuration's model pin takes precedence over `model`. Other explicit spawn values refine the resolved configuration, while omitted model and thinking values inherit from the calling agent when the configuration does not set them.

In the main conversation, start a message with `@configuration-id task` to launch that configuration directly, for example `@review Check the changes in src/`. For a nested configuration ID, use `@agent:quality/review task`. Typing `@` offers visible, enabled `subagent` and `all` configurations allowed by the parent. The launch uses the current working directory and the same configuration model pins, permissions, and approval rules as `agent_spawn`. Each mention creates a new delegated conversation; retained subagents receive follow-up work through the parent agent. Only a leading, known configuration ID followed by a task invokes an agent; file mentions, email addresses, and unknown IDs remain ordinary input.

Agent configurations are optional. `agent_templates` is available through Pi's `tool_search`; listing uses `offset` and `limit` with a default of 20 entries and returns `nextOffset` when more remain. Configuration bodies are returned only by `get`.

Configuration permissions apply to the conversation created from that profile. The calling agent's `subagent` permission also controls which configured agents it may launch. See [agent configurations](agents.md) for scope merging, modes, defaults, and Markdown fields.

Six agents run concurrently; additional agents queue. Each workspace can hold 64 additional agents. `autoCleanup: true` disposes finished agents and releases their slots while preserving results.

Agents have no execution deadline unless `timeoutMs` is set. `agent_wait` defaults to 60 seconds and all agents, including history; a timeout leaves agents running. Pass specific IDs to avoid repeating older results. For successive `mode: "any"` waits, pass only unfinished IDs.

Poll `agent_inbox` with `after: 0`, then reuse its `nextAfter` cursor to read new messages in arrival order. `hasMore` indicates another page; `missed` reports messages lost beyond the 100-message retention window. Cursors belong to the current workspace. Without `after`, inbox reads use newest-first history with `offset`. Use `messageId` to read a full message. Messages do not trigger main-agent turns.

Spawn, send, and cancel return short acknowledgements. Status and wait return results; truncated output includes `outputTruncated` and `resultFile` for reading the full text.

The GUI provides individual and collective cancellation. **Stop** stops the selected agent's current work; other agents continue.

Select a workspace and click **Close workspace** in its header, or use **Menu → Close workspace**. Closing a workspace stops all of its agents, closes its embedded terminal, and frees its workspace slot. Saved history remains available through **Menu → Resume session**. Closing the last workspace returns to the start screen, where **Recent projects** offers one-click access to your last twelve project folders. For a workspace attached from another terminal, **Close workspace** dismisses it from this window.

Resuming a saved conversation replaces other open workspaces in the same folder, stopping their agents; workspaces in other folders stay open. If the chosen conversation is already open, its workspace is reused rather than duplicated. If it cannot be loaded, the current workspaces stay open.

Each workspace factory has a stable, theme-aware color and architectural variation. Idle main agents can visit other idle factories, then hurry back when prompted or when their workspace starts working. Visiting robots react to hits and recover before continuing their trip. **Menu → Appearance → Motion** (and your system's reduced-motion preference) controls these animations.

Choose **Cane** to swing at robots by waving the mouse, or **Gun** to aim and click to shoot. Right-click or press **Esc** to holster either tool. Hits affect the scene's robots without interrupting agent work.

## Browsing and files

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

```json
{
  "path": "data/*.json",
  "collectionPath": "items",
  "where": {"status": "open"},
  "groupBy": ["owner"],
  "sampleLimit": 5
}
```

## Images

`openai_image` generates or edits images through the OpenAI Images API. It uses the OpenAI account connected in **Accounts** or `OPENAI_API_KEY`.

Choose from six image presets on first GUI use or in **Menu → Tool models → OpenAI images**. The `model` parameter and `OPENAI_IMAGE_MODEL` override the saved choice. Headless use defaults to `gpt-image-2.5-flare` when no model is configured.

- `prompt`: generation or editing instructions.
- `inputImagePaths`: local reference images for editing.
- `size`, `quality`, `background`, `outputFormat`: image options supported by the selected model.
- `outputDir`, `filenamePrefix`: destination controls.

Images are saved under `generated-images/` unless configured otherwise. Results appear in the conversation.

See [OpenAI's image generation guide](https://developers.openai.com/api/docs/guides/image-generation).
