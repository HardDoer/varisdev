# VarisDev agents and tools

[Back to VarisDev](../README.md)

This page covers VarisDev's additions. See [Pi's documentation](https://github.com/earendil-works/pi/tree/main/packages/coding-agent) for the underlying runtime.

## Agents

Each agent has its own conversation and shares its selected working directory. It inherits the parent model and thinking level unless explicitly configured. Without a parent model, `agent_spawn` requires a model choice.

**Menu → Agent models** controls which models `agent_spawn` may use. The restriction also applies to inherited models. The tool shows the configured choices to the parent model and checks them when agents start or resume. See [model configuration](configuration.md#agent-models).

| Tool | Purpose |
| --- | --- |
| `agent_spawn` | Start an agent and return its ID. |
| `agent_list` | List active agents, history, or both. |
| `agent_status` | Read status, results, and transcript paths. |
| `agent_send` | Steer active work or resume a completed agent. |
| `agent_inbox` | Read messages sent to the parent session. |
| `agent_wait` | Wait for selected agents to finish. |
| `agent_cancel` | Cancel an agent and its queued messages. |

`agent_spawn` requires `name` and `task`. Optional fields: `instructions`, `cwd`, `model` (`provider/model`), `thinkingLevel`, `timeoutMs`, and `autoCleanup`.

Six agents run concurrently; additional agents queue. Each parent session can hold 64 agents. `autoCleanup: true` disposes finished agents and releases their slots while preserving results.

Agents have no execution deadline unless `timeoutMs` is set. `agent_wait` defaults to 60 seconds; a wait timeout leaves agents running. Messages to the parent go to its inbox and do not trigger model turns.

The GUI provides individual and collective cancellation. **Stop** stops the parent while its agents continue.

Select a parent and click **Close session** beside **Context files**, or use **Menu → Close session**. Closing a desktop parent stops its work and agents, closes its embedded terminal, and frees its session slot. Saved history remains available through **Menu → Resume session**. Closing the last parent returns to **Open folder**. For a session attached from another terminal, **Close session** dismisses it from this window.

## Commit and push

`/commit [instructions]` delegates committing and pushing to an agent. Choose its model and reasoning level in **Menu → Commit settings**, or inherit those values from the parent session. Its model must be allowed in **Agent models**. The agent inspects the changes, runs checks, and reports the result.

## Browsing and files

| Tool | Purpose |
| --- | --- |
| `browse` | Read web pages, links, raw text, or selected JSON fields. |
| `download` | Save a URL to a project file. |
| `json_query` | Filter, group, and sample JSON files. |
| `gamemaker_query` | Query GameMaker `.yy` and `.yyp` files, including trailing commas. |
| `image_query` | Inspect image dimensions, alpha bounds, and grid occupancy. |
| `image_preview` | Display a local image in the conversation. |

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

`openai_image` generates or edits images through the OpenAI Images API. It uses the OpenAI account connected in **Accounts**, or `OPENAI_API_KEY`, and requires a user-selected image model.

Choose the model on first GUI use or in **Accounts → Tool models**. The `model` parameter and `OPENAI_IMAGE_MODEL` can override the saved choice.

- `prompt`: generation or editing instructions.
- `inputImagePaths`: local reference images for editing.
- `size`, `quality`, `background`, `outputFormat`: image options supported by the selected model.
- `outputDir`, `filenamePrefix`: destination controls.

Images are saved under `generated-images/` unless configured otherwise. Results appear in the conversation.

See [OpenAI's image API reference](https://platform.openai.com/docs/api-reference/images).

## Audio

`elevenlabs` requires `ELEVENLABS_API_KEY` and supports:

- `list_voices`: find voices by search and pagination.
- `text_to_speech`: generate speech using `voiceId` and `text`.
- `sound_effects`: generate audio from a description in `text`.

Speech and effects have separate user-selected models. Choose them on first GUI use or in **Accounts → Tool models**. `modelId` overrides the saved choice for one request.

Optional controls include `voiceSettings`, `languageCode`, `seed`, `durationSeconds`, `loop`, `promptInfluence`, and `outputFormat`, depending on the action and model. The current sound-effects endpoint accepts `eleven_text_to_sound_v2`.

Audio is saved under `generated-audio/` unless `outputDir` is set.

See ElevenLabs' [speech](https://elevenlabs.io/docs/api-reference/text-to-speech/convert), [sound effects](https://elevenlabs.io/docs/api-reference/text-to-sound-effects/convert), and [voices](https://elevenlabs.io/docs/api-reference/voices/search) references.
