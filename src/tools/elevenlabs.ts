import {
  formatSize,
  truncateHead,
  type ExtensionAPI,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {mkdir, open, rename, rm, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import type {ReadableStream as NodeReadableStream} from 'node:stream/web';
import {Type, type Static} from 'typebox';
import {selectToolModel} from './model-selection.ts';

const API_URL = 'https://api.elevenlabs.io';
const API_KEY_ENV_VAR = 'ELEVENLABS_API_KEY';
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';
const OUTPUT_FORMATS = [
  'mp3_22050_32',
  'mp3_24000_48',
  'mp3_44100_32',
  'mp3_44100_64',
  'mp3_44100_96',
  'mp3_44100_128',
  'mp3_44100_192',
  'pcm_8000',
  'pcm_16000',
  'pcm_22050',
  'pcm_24000',
  'pcm_32000',
  'pcm_44100',
  'pcm_48000',
  'wav_8000',
  'wav_16000',
  'wav_22050',
  'wav_24000',
  'wav_32000',
  'wav_44100',
  'wav_48000',
  'ulaw_8000',
  'alaw_8000',
  'opus_48000_32',
  'opus_48000_64',
  'opus_48000_96',
  'opus_48000_128',
  'opus_48000_192',
] as const;

const elevenLabsSchema = Type.Object({
  action: Type.Union(
    [
      Type.Literal('list_voices'),
      Type.Literal('text_to_speech'),
      Type.Literal('sound_effects'),
    ],
    {
      description:
        'Find available voices, generate speech, or generate a sound effect.',
    },
  ),
  text: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Required for generation: the words to speak or a description of the sound effect.',
    }),
  ),
  voiceId: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Required for text_to_speech. Choose a voice ID from list_voices.',
    }),
  ),
  modelId: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Generation model chosen by the user. Otherwise uses the saved choice or asks on first GUI use.',
    }),
  ),
  languageCode: Type.Optional(
    Type.String({
      description:
        'Speech only: ISO 639-1 language code, when supported by the selected model. Not supported by eleven_multilingual_v2.',
    }),
  ),
  voiceSettings: Type.Optional(
    Type.Object(
      {
        stability: Type.Optional(Type.Number({minimum: 0, maximum: 1})),
        similarityBoost: Type.Optional(Type.Number({minimum: 0, maximum: 1})),
        style: Type.Optional(Type.Number({minimum: 0, maximum: 1})),
        speed: Type.Optional(Type.Number({minimum: 0.7, maximum: 1.2})),
        useSpeakerBoost: Type.Optional(Type.Boolean()),
      },
      {
        description:
          'Speech only: override voice settings for this request. Supported settings depend on the model.',
      },
    ),
  ),
  seed: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 4294967295,
      description: 'Speech only: optional seed for best effort repeatability.',
    }),
  ),
  durationSeconds: Type.Optional(
    Type.Number({
      minimum: 0.5,
      maximum: 30,
      description:
        'Sound effects only: duration in seconds. Omit to let the model choose.',
    }),
  ),
  promptInfluence: Type.Optional(
    Type.Number({
      minimum: 0,
      maximum: 1,
      description:
        'Sound effects only: how closely to follow the prompt. API default is 0.3.',
    }),
  ),
  loop: Type.Optional(
    Type.Boolean({
      description:
        'Sound effects only: create a seamless loop. Defaults to false.',
    }),
  ),
  outputFormat: Type.Optional(
    Type.Union(
      OUTPUT_FORMATS.map(format => Type.Literal(format)),
      {
        description: `Generation audio format. Defaults to ${DEFAULT_OUTPUT_FORMAT}. WAV is supported for speech only; PCM is raw audio without a WAV header. Some formats require a higher ElevenLabs subscription tier.`,
      },
    ),
  ),
  outputDir: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        'Directory for generated audio. Defaults to generated-audio under the current project. Accepts absolute paths or relative paths, optionally prefixed with @.',
    }),
  ),
  filenamePrefix: Type.Optional(
    Type.String({
      description:
        'Optional filename prefix. The tool sanitizes it and appends a timestamp and random suffix.',
    }),
  ),
  search: Type.Optional(
    Type.String({
      description:
        'list_voices only: search voice names, descriptions, labels, and categories.',
    }),
  ),
  pageSize: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description:
        'list_voices only: number of voices per page. Defaults to 20. The API may include extra default voices on the first page.',
    }),
  ),
  nextPageToken: Type.Optional(
    Type.String({
      description:
        'list_voices only: token from the previous result. Keep the same search when paging.',
    }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: `Timeout for the request and response download. Defaults to ${DEFAULT_TIMEOUT_MS}ms; maximum ${MAX_TIMEOUT_MS}ms.`,
    }),
  ),
});

type Params = Static<typeof elevenLabsSchema>;
type Voice = {
  voiceId: string;
  name?: string;
  category?: string;
  description?: string | null;
  labels?: Record<string, string>;
  previewUrl?: string | null;
};
type VoicesResponse = {
  voices: Array<{
    voice_id: string;
    name?: string;
    category?: string;
    description?: string | null;
    labels?: Record<string, string>;
    preview_url?: string | null;
  }>;
  has_more: boolean;
  next_page_token?: string | null;
};
type ToolDetails = {
  action: Params['action'];
  modelId?: string;
  voiceId?: string;
  outputFormat?: string;
  audio?: {path: string; bytes: number; mimeType: string};
  voices?: Voice[];
  hasMore?: boolean;
  nextPageToken?: string | null;
  requestId?: string;
  characterCost?: string;
};

function requiredText(value: string | undefined, name: string): string {
  if (!value?.trim())
    throw new Error(`${name} is required and cannot be empty.`);
  return value;
}

function makeGenerationRequest(params: Params): {
  url: URL;
  body: Record<string, unknown>;
  modelId: string;
  outputFormat: string;
  extension: string;
} {
  const text = requiredText(params.text, 'text');
  const speech = params.action === 'text_to_speech';
  const outputFormat = params.outputFormat ?? DEFAULT_OUTPUT_FORMAT;
  if (!OUTPUT_FORMATS.includes(outputFormat)) {
    throw new Error(`Unsupported outputFormat: ${outputFormat}`);
  }
  if (!speech && outputFormat.startsWith('wav_')) {
    throw new Error(
      'WAV output is available for text_to_speech only. Use MP3 or PCM for sound_effects.',
    );
  }
  const modelId = requiredText(params.modelId, 'modelId').trim();
  if (!speech && modelId !== 'eleven_text_to_sound_v2') {
    throw new Error('sound_effects requires modelId eleven_text_to_sound_v2.');
  }
  const endpoint = speech
    ? `/v1/text-to-speech/${encodeURIComponent(requiredText(params.voiceId, 'voiceId').trim())}`
    : '/v1/sound-generation';
  const url = new URL(endpoint, API_URL);
  url.searchParams.set('output_format', outputFormat);
  const settings = params.voiceSettings;
  const body = speech
    ? {
        text,
        model_id: modelId,
        language_code: params.languageCode,
        seed: params.seed,
        voice_settings: settings && {
          stability: settings.stability,
          similarity_boost: settings.similarityBoost,
          style: settings.style,
          speed: settings.speed,
          use_speaker_boost: settings.useSpeakerBoost,
        },
      }
    : {
        text,
        model_id: modelId,
        duration_seconds: params.durationSeconds,
        prompt_influence: params.promptInfluence,
        loop: params.loop,
      };
  return {
    url,
    body,
    modelId,
    outputFormat,
    extension: outputFormat.split('_')[0],
  };
}

/** Bound response bodies; errors can retain a prefix, but JSON must be complete. */
async function readText(
  response: Response,
  maxBytes: number,
  keepPrefix = false,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      if (bytes + value.byteLength > maxBytes) {
        if (!keepPrefix) {
          throw new Error(
            'ElevenLabs response exceeded the size limit. Try a smaller pageSize for voice searches.',
          );
        }
        chunks.push(value.subarray(0, maxBytes - bytes));
        break;
      }
      bytes += value.byteLength;
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function checkResponse(
  response: Response,
  apiKey: string,
): Promise<void> {
  if (response.ok) return;
  let message = await readText(response, 16 * 1024, true).catch(
    () => response.statusText,
  );
  try {
    const error = JSON.parse(message) as {detail?: unknown};
    if (error.detail !== undefined) message = JSON.stringify(error.detail);
  } catch {
    // Some upstream failures return plain text instead of JSON.
  }
  message = message.replaceAll(apiKey, '[redacted]').slice(0, 2000);
  throw new Error(
    `ElevenLabs API error ${response.status}: ${message || response.statusText}`,
  );
}

async function listVoices(
  params: Params,
  apiKey: string,
  signal: AbortSignal,
): Promise<ToolDetails> {
  const url = new URL('/v2/voices', API_URL);
  url.searchParams.set('page_size', String(params.pageSize ?? 20));
  url.searchParams.set('include_total_count', 'false');
  if (params.search) url.searchParams.set('search', params.search);
  if (params.nextPageToken)
    url.searchParams.set('next_page_token', params.nextPageToken);
  const response = await fetch(url, {
    method: 'GET',
    headers: {'xi-api-key': apiKey, Accept: 'application/json'},
    redirect: 'error',
    signal,
  });
  await checkResponse(response, apiKey);
  const data = JSON.parse(
    await readText(response, 8 * 1024 * 1024),
  ) as VoicesResponse;
  if (!Array.isArray(data.voices) || typeof data.has_more !== 'boolean') {
    throw new Error('ElevenLabs returned an invalid voice list.');
  }
  const voices = data.voices.map(voice => {
    if (!voice || typeof voice.voice_id !== 'string') {
      throw new Error('ElevenLabs returned a voice without a voice ID.');
    }
    return {
      voiceId: voice.voice_id,
      name: voice.name,
      category: voice.category,
      description: voice.description,
      labels: voice.labels,
      previewUrl: voice.preview_url,
    };
  });
  return {
    action: 'list_voices',
    hasMore: data.has_more,
    nextPageToken: data.next_page_token ?? null,
    voices,
  };
}

async function generateAudio(
  params: Params,
  cwd: string,
  apiKey: string,
  signal: AbortSignal,
): Promise<ToolDetails> {
  const request = makeGenerationRequest(params);
  const rawDir = params.outputDir?.trim() ?? 'generated-audio';
  const directory = rawDir.startsWith('@') ? rawDir.slice(1) : rawDir;
  if (!directory) throw new Error('outputDir cannot be empty.');
  const outputDir = resolve(cwd, directory);
  const prefix =
    params.filenamePrefix
      ?.trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || params.action;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${prefix}-${timestamp}-${randomUUID()}.${request.extension}`;
  const path = join(outputDir, filename);
  const temporaryPath = join(outputDir, `.${filename}.part`);

  return withFileMutationQueue(path, async () => {
    signal.throwIfAborted();
    await mkdir(outputDir, {recursive: true});
    // Open the destination before starting a paid generation request.
    const file = await open(temporaryPath, 'wx');
    let response: Response | undefined;
    try {
      signal.throwIfAborted();
      response = await fetch(request.url, {
        method: 'POST',
        headers: {'xi-api-key': apiKey, 'Content-Type': 'application/json'},
        body: JSON.stringify(request.body),
        redirect: 'error',
        signal,
      });
      await checkResponse(response, apiKey);
      if (!response.body) throw new Error('ElevenLabs returned no audio.');
      const contentType = response.headers
        .get('content-type')
        ?.split(';')[0]
        .trim()
        .toLowerCase();
      if (
        contentType &&
        !contentType.startsWith('audio/') &&
        ![
          'application/octet-stream',
          'binary/octet-stream',
          'application/ogg',
        ].includes(contentType)
      ) {
        throw new Error(
          `ElevenLabs returned an unexpected audio content type: ${contentType}`,
        );
      }
      await pipeline(
        Readable.fromWeb(response.body as unknown as NodeReadableStream),
        file.createWriteStream(),
        {signal},
      );
      const {size} = await stat(temporaryPath);
      if (size === 0) throw new Error('ElevenLabs returned empty audio.');
      signal.throwIfAborted();
      await rename(temporaryPath, path);
      return {
        action: params.action,
        modelId: request.modelId,
        voiceId:
          params.action === 'text_to_speech'
            ? params.voiceId?.trim()
            : undefined,
        outputFormat: request.outputFormat,
        audio: {
          path,
          bytes: size,
          mimeType: contentType ?? 'application/octet-stream',
        },
        requestId:
          response.headers.get('request-id') ??
          response.headers.get('x-request-id') ??
          undefined,
        characterCost: response.headers.get('character-cost') ?? undefined,
      };
    } finally {
      await file.close();
      await rm(temporaryPath, {force: true});
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => {});
    }
  });
}

export function registerElevenLabsTool(pi: ExtensionAPI): void {
  pi.registerTool<typeof elevenLabsSchema, ToolDetails>({
    name: 'elevenlabs',
    label: 'ElevenLabs',
    description:
      'Generate speech or sound effects with ElevenLabs and save audio files in the current project. Search available voices with list_voices. Uses ELEVENLABS_API_KEY from the environment.',
    promptSnippet:
      'Generate spoken audio and sound effects with ElevenLabs, or find voices to use for speech.',
    promptGuidelines: [
      'Use elevenlabs for voice lines, narration, and sound effects. Use list_voices to find a voiceId before text_to_speech when no voice ID was supplied.',
      'elevenlabs reads ELEVENLABS_API_KEY from the environment; never pass an API key in tool arguments.',
      'Generation returns local audio paths. Refer to these paths in your response.',
    ],
    parameters: elevenLabsSchema,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const apiKey = process.env[API_KEY_ENV_VAR]?.trim();
      if (!apiKey)
        throw new Error(
          `Missing ElevenLabs API key. Set ${API_KEY_ENV_VAR} before starting Pi.`,
        );
      if (
        !['list_voices', 'text_to_speech', 'sound_effects'].includes(
          params.action,
        )
      ) {
        throw new Error(
          'Unknown elevenlabs action. Use list_voices, text_to_speech, or sound_effects.',
        );
      }
      if (params.action !== 'list_voices') {
        requiredText(params.text, 'text');
        const speech = params.action === 'text_to_speech';
        if (speech) requiredText(params.voiceId, 'voiceId');
        params = {
          ...params,
          modelId: await selectToolModel(
            speech ? 'elevenlabs-speech' : 'elevenlabs-effects',
            params.modelId,
            ctx,
            signal,
          ),
        };
      }
      const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      if (
        !Number.isInteger(timeoutMs) ||
        timeoutMs < 1 ||
        timeoutMs > MAX_TIMEOUT_MS
      ) {
        throw new Error(
          `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}.`,
        );
      }
      const timeout = AbortSignal.timeout(timeoutMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, timeout])
        : timeout;
      try {
        requestSignal.throwIfAborted();
        const details =
          params.action === 'list_voices'
            ? await listVoices(params, apiKey, requestSignal)
            : await generateAudio(params, ctx.cwd, apiKey, requestSignal);
        const output = details.audio
          ? `Saved ElevenLabs audio: ${details.audio.path} (${details.outputFormat}, ${formatSize(details.audio.bytes)})${details.requestId ? `\nRequest ID: ${details.requestId}` : ''}${details.characterCost ? `\nCharacter cost: ${details.characterCost}` : ''}`
          : JSON.stringify(details, null, 2);
        const truncated = truncateHead(output);
        return {
          content: [
            {
              type: 'text',
              text:
                truncated.content +
                (truncated.truncated
                  ? '\nVoice list truncated. Repeat with a smaller pageSize or a narrower search.'
                  : ''),
            },
          ],
          details,
        };
      } catch (error) {
        if (timeout.aborted && !signal?.aborted) {
          throw new Error(`ElevenLabs request timed out after ${timeoutMs}ms.`);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(message.replaceAll(apiKey, '[redacted]'));
      }
    },
  });
}
