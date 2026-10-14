import assert from 'node:assert/strict';
import {basename, extname, join} from 'node:path';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {test} from 'node:test';
import type {ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {registerElevenLabsTool} from '../src/tools/elevenlabs.ts';

type ToolResult = {
  content: Array<{type: string; text?: string}>;
  details: unknown;
};

type CapturedTool = {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((update: ToolResult) => void) | undefined,
    ctx: {cwd: string},
  ) => Promise<ToolResult>;
};

function captureTool(): CapturedTool {
  let captured: CapturedTool | undefined;
  const pi = {
    registerTool(definition: unknown) {
      captured = definition as CapturedTool;
    },
  } as unknown as ExtensionAPI;

  registerElevenLabsTool(pi);
  assert.ok(captured, 'the tool should be registered');
  return captured;
}

function resultText(result: ToolResult): string {
  const content = result.content[0];
  assert.equal(content?.type, 'text');
  return content.text ?? '';
}

function restoreEnvironmentVariable(
  name: string,
  originalValue: string | undefined,
): void {
  if (originalValue === undefined) delete process.env[name];
  else process.env[name] = originalValue;
}

async function makeTempDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'varisdev-elevenlabs-'));
}

void test('elevenlabs reads its trimmed API key when the tool executes', async () => {
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;

  delete process.env.ELEVENLABS_API_KEY;
  const tool = captureTool();
  assert.equal(tool.name, 'elevenlabs');
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called');
  }) as typeof fetch;

  try {
    process.env.ELEVENLABS_API_KEY = '   ';
    await assert.rejects(
      tool.execute(
        'missing-key',
        {action: 'list_voices'},
        undefined,
        undefined,
        {cwd: process.cwd()},
      ),
      /ELEVENLABS_API_KEY/,
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentVariable('ELEVENLABS_API_KEY', originalApiKey);
  }
});

void test('text_to_speech maps options and streams audio to a relative output directory', async () => {
  const tool = captureTool();
  const cwd = await makeTempDirectory();
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  const originalFetch = globalThis.fetch;
  const audioBytes = Buffer.from([0x49, 0x44, 0x33, 1, 2, 3]);
  const voiceId = 'voice/id ?';
  let requestBody: Record<string, unknown> | undefined;

  process.env.ELEVENLABS_API_KEY = '  speech-test-key  ';
  globalThis.fetch = (async (input, init) => {
    assert.equal(
      String(input),
      'https://api.elevenlabs.io/v1/text-to-speech/voice%2Fid%20%3F?output_format=mp3_44100_128',
    );
    assert.equal(init?.method, 'POST');
    const headers = new Headers(init?.headers);
    assert.equal(headers.get('xi-api-key'), 'speech-test-key');
    assert.equal(headers.get('content-type'), 'application/json');
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(audioBytes, {
      status: 200,
      headers: {
        'content-type': 'audio/mpeg',
        'request-id': 'request-123',
        'character-cost': '17',
      },
    });
  }) as typeof fetch;

  try {
    const result = await tool.execute(
      'speech',
      {
        action: 'text_to_speech',
        modelId: 'eleven_multilingual_v2',
        text: 'Hyvää päivää',
        voiceId,
        languageCode: 'fi',
        seed: 0,
        voiceSettings: {
          stability: 0,
          similarityBoost: 0.75,
          style: 0,
          speed: 1,
          useSpeakerBoost: false,
        },
        outputDir: '@audio output',
        filenamePrefix: ' My unsafe / prefix! ',
      },
      undefined,
      undefined,
      {cwd},
    );
    const details = result.details as {
      action: string;
      modelId: string;
      voiceId: string;
      outputFormat: string;
      audio: {path: string; bytes: number; mimeType: string};
      requestId?: string;
      characterCost?: string;
    };

    assert.deepEqual(requestBody, {
      text: 'Hyvää päivää',
      model_id: 'eleven_multilingual_v2',
      language_code: 'fi',
      seed: 0,
      voice_settings: {
        stability: 0,
        similarity_boost: 0.75,
        style: 0,
        speed: 1,
        use_speaker_boost: false,
      },
    });
    assert.equal(details.action, 'text_to_speech');
    assert.equal(details.modelId, 'eleven_multilingual_v2');
    assert.equal(details.voiceId, voiceId);
    assert.equal(details.outputFormat, 'mp3_44100_128');
    assert.equal(details.audio.bytes, audioBytes.byteLength);
    assert.equal(details.audio.mimeType, 'audio/mpeg');
    assert.equal(details.requestId, 'request-123');
    assert.equal(details.characterCost, '17');
    assert.equal(
      details.audio.path.startsWith(join(cwd, 'audio output')),
      true,
    );
    assert.match(basename(details.audio.path), /^my-unsafe-prefix-.+\.mp3$/);
    assert.deepEqual(await readFile(details.audio.path), audioBytes);
    assert.match(
      resultText(result),
      new RegExp(details.audio.path.replaceAll('\\', '\\\\')),
    );
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentVariable('ELEVENLABS_API_KEY', originalApiKey);
    await rm(cwd, {recursive: true, force: true});
  }
});

void test('sound_effects sends its defaults and retains zero and false options', async () => {
  const tool = captureTool();
  const cwd = await makeTempDirectory();
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  const originalFetch = globalThis.fetch;
  const audioBytes = Buffer.from('sound effect bytes');
  let requestBody: Record<string, unknown> | undefined;

  process.env.ELEVENLABS_API_KEY = 'sfx-test-key';
  globalThis.fetch = (async (input, init) => {
    assert.equal(
      String(input),
      'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128',
    );
    assert.equal(init?.method, 'POST');
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(audioBytes, {
      status: 200,
      headers: {'content-type': 'audio/mpeg'},
    });
  }) as typeof fetch;

  try {
    const result = await tool.execute(
      'sound-effect',
      {
        action: 'sound_effects',
        modelId: 'eleven_text_to_sound_v2',
        text: 'A short impact',
        durationSeconds: 0.5,
        promptInfluence: 0,
        loop: false,
      },
      undefined,
      undefined,
      {cwd},
    );
    const details = result.details as {
      action: string;
      modelId: string;
      outputFormat: string;
      audio: {path: string};
    };

    assert.deepEqual(requestBody, {
      text: 'A short impact',
      model_id: 'eleven_text_to_sound_v2',
      duration_seconds: 0.5,
      prompt_influence: 0,
      loop: false,
    });
    assert.equal(details.action, 'sound_effects');
    assert.equal(details.modelId, 'eleven_text_to_sound_v2');
    assert.equal(details.outputFormat, 'mp3_44100_128');
    assert.equal(
      details.audio.path.startsWith(join(cwd, 'generated-audio')),
      true,
    );
    assert.deepEqual(await readFile(details.audio.path), audioBytes);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentVariable('ELEVENLABS_API_KEY', originalApiKey);
    await rm(cwd, {recursive: true, force: true});
  }
});

void test('list_voices sends pagination filters and returns compact camelCase voices', async () => {
  const tool = captureTool();
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  const originalFetch = globalThis.fetch;

  process.env.ELEVENLABS_API_KEY = 'voices-test-key';
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(
      url.origin + url.pathname,
      'https://api.elevenlabs.io/v2/voices',
    );
    assert.equal(url.searchParams.get('page_size'), '20');
    assert.equal(url.searchParams.get('include_total_count'), 'false');
    assert.equal(url.searchParams.get('search'), 'narrator');
    assert.equal(url.searchParams.get('next_page_token'), 'page-2');
    assert.equal(init?.method, 'GET');
    assert.equal(
      new Headers(init?.headers).get('xi-api-key'),
      'voices-test-key',
    );
    return Response.json({
      voices: [
        {
          voice_id: 'voice-1',
          name: 'Narrator',
          category: 'premade',
          description: 'A compact test voice',
          labels: {accent: 'neutral'},
          preview_url: 'https://example.test/preview.mp3',
          settings: {similarity_boost: 0.8, huge: 'exclude-this-marker'},
          samples: [{sample_id: 'bloated-sample-marker'}],
        },
      ],
      has_more: true,
      total_count: 38,
      next_page_token: 'page-3',
    });
  }) as typeof fetch;

  try {
    const result = await tool.execute(
      'voices',
      {
        action: 'list_voices',
        search: 'narrator',
        nextPageToken: 'page-2',
      },
      undefined,
      undefined,
      {cwd: process.cwd()},
    );
    const details = result.details as {
      action: string;
      voices: Array<Record<string, unknown>>;
      hasMore: boolean;
      nextPageToken: string | null;
    };
    const voice = details.voices[0];

    assert.equal(details.action, 'list_voices');
    assert.equal(voice?.voiceId, 'voice-1');
    assert.equal(voice?.name, 'Narrator');
    assert.equal(voice?.category, 'premade');
    assert.equal(voice?.description, 'A compact test voice');
    assert.deepEqual(voice?.labels, {accent: 'neutral'});
    assert.equal(voice?.previewUrl, 'https://example.test/preview.mp3');
    assert.equal(details.hasMore, true);
    assert.equal(details.nextPageToken, 'page-3');
    assert.doesNotMatch(JSON.stringify(result), /exclude-this-marker/);
    assert.doesNotMatch(JSON.stringify(result), /bloated-sample-marker/);
    assert.doesNotMatch(JSON.stringify(voice), /voice_id|preview_url/);
    assert.match(resultText(result), /Narrator/);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentVariable('ELEVENLABS_API_KEY', originalApiKey);
  }
});

void test('generation errors include a bounded status message, redact the key, and leave no files', async () => {
  const tool = captureTool();
  const cwd = await makeTempDirectory();
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  const originalFetch = globalThis.fetch;
  const secret = 'secret-key-that-must-not-leak';
  let fetchCount = 0;

  process.env.ELEVENLABS_API_KEY = secret;
  globalThis.fetch = (async () => {
    fetchCount++;
    return new Response(
      JSON.stringify({
        detail: `Quota exceeded for ${secret}. ${'x'.repeat(40_000)}`,
      }),
      {status: 429, statusText: 'Too Many Requests'},
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      tool.execute(
        'failed-speech',
        {
          action: 'text_to_speech',
          modelId: 'eleven_multilingual_v2',
          text: 'This request fails',
          voiceId: 'voice-1',
          outputDir: 'failed-output',
        },
        undefined,
        undefined,
        {cwd},
      ),
      error => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /429/);
        assert.match(error.message, /Quota exceeded/);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.ok(
          error.message.length < 10_000,
          'the API error must be bounded',
        );
        return true;
      },
    );
    assert.equal(fetchCount, 1, 'generation errors must not be retried');
    assert.deepEqual(await readdir(join(cwd, 'failed-output')), []);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentVariable('ELEVENLABS_API_KEY', originalApiKey);
    await rm(cwd, {recursive: true, force: true});
  }
});

void test('conditional fields and sound-effect WAV formats fail before fetch', async () => {
  const tool = captureTool();
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;

  process.env.ELEVENLABS_API_KEY = 'validation-test-key';
  globalThis.fetch = (async () => {
    fetchCount++;
    throw new Error('fetch should not be called');
  }) as typeof fetch;

  try {
    const invalidRequests: Array<{
      params: Record<string, unknown>;
      message: RegExp;
    }> = [
      {
        params: {
          action: 'text_to_speech',
          modelId: 'eleven_multilingual_v2',
          voiceId: 'voice-1',
        },
        message: /text/i,
      },
      {
        params: {
          action: 'text_to_speech',
          modelId: 'eleven_multilingual_v2',
          text: 'Hello',
        },
        message: /voiceId/i,
      },
      {params: {action: 'sound_effects'}, message: /text/i},
      {
        params: {
          action: 'sound_effects',
          modelId: 'eleven_text_to_sound_v2',
          text: 'A bell',
          outputFormat: 'wav_44100',
        },
        message: /wav/i,
      },
    ];

    for (const [index, request] of invalidRequests.entries()) {
      await assert.rejects(
        tool.execute(`invalid-${index}`, request.params, undefined, undefined, {
          cwd: process.cwd(),
        }),
        request.message,
      );
    }
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentVariable('ELEVENLABS_API_KEY', originalApiKey);
  }
});

void test('audio codec prefixes select the generated file extension', async () => {
  const tool = captureTool();
  const cwd = await makeTempDirectory();
  const originalApiKey = process.env.ELEVENLABS_API_KEY;
  const originalFetch = globalThis.fetch;
  const formats = [
    ['mp3_44100_128', '.mp3'],
    ['wav_44100', '.wav'],
    ['pcm_16000', '.pcm'],
    ['ulaw_8000', '.ulaw'],
    ['alaw_8000', '.alaw'],
    ['opus_48000_64', '.opus'],
  ] as const;

  process.env.ELEVENLABS_API_KEY = 'format-test-key';
  globalThis.fetch = (async () =>
    new Response(Buffer.from('audio'), {
      status: 200,
      headers: {'content-type': 'application/octet-stream'},
    })) as typeof fetch;

  try {
    for (const [outputFormat, expectedExtension] of formats) {
      const result = await tool.execute(
        `format-${outputFormat}`,
        {
          action: 'text_to_speech',
          modelId: 'eleven_multilingual_v2',
          text: 'Format test',
          voiceId: 'voice-1',
          outputFormat,
          outputDir: 'formats',
        },
        undefined,
        undefined,
        {cwd},
      );
      const details = result.details as {audio: {path: string}};
      assert.equal(extname(details.audio.path), expectedExtension);
    }
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironmentVariable('ELEVENLABS_API_KEY', originalApiKey);
    await rm(cwd, {recursive: true, force: true});
  }
});

void test(
  'timeouts and cancellation during an audio stream remove partial files',
  {timeout: 5000},
  async () => {
    const tool = captureTool();
    const cwd = await makeTempDirectory();
    const originalApiKey = process.env.ELEVENLABS_API_KEY;
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    let timeoutBodyStarted = false;
    let resolveCancellationBodyStarted!: () => void;
    const cancellationBodyStarted = new Promise<void>(resolve => {
      resolveCancellationBodyStarted = resolve;
    });

    process.env.ELEVENLABS_API_KEY = 'stream-test-key';
    globalThis.fetch = (async (_input, init) => {
      const requestIndex = fetchCount++;
      const signal = init?.signal;
      let sentFirstChunk = false;
      const body = new ReadableStream<Uint8Array>(
        {
          start(controller) {
            signal?.addEventListener(
              'abort',
              () => controller.error(signal.reason),
              {once: true},
            );
          },
          pull(controller) {
            if (sentFirstChunk) return;
            sentFirstChunk = true;
            controller.enqueue(new Uint8Array([1, 2, 3]));
            if (requestIndex === 0) timeoutBodyStarted = true;
            else resolveCancellationBodyStarted();
          },
        },
        {highWaterMark: 0},
      );
      return new Response(body, {
        status: 200,
        headers: {'content-type': 'audio/mpeg'},
      });
    }) as typeof fetch;

    try {
      await assert.rejects(
        tool.execute(
          'stream-timeout',
          {
            action: 'text_to_speech',
            modelId: 'eleven_multilingual_v2',
            text: 'Timeout test',
            voiceId: 'voice-1',
            outputDir: 'timeout-output',
            timeoutMs: 200,
          },
          undefined,
          undefined,
          {cwd},
        ),
        /timed out after 200ms/i,
      );
      assert.equal(fetchCount, 1);
      assert.equal(
        timeoutBodyStarted,
        true,
        'the timeout must happen after response streaming starts',
      );

      const controller = new AbortController();
      const cancelled = tool.execute(
        'stream-cancel',
        {
          action: 'text_to_speech',
          modelId: 'eleven_multilingual_v2',
          text: 'Cancellation test',
          voiceId: 'voice-1',
          outputDir: 'cancel-output',
          timeoutMs: 5_000,
        },
        controller.signal,
        undefined,
        {cwd},
      );
      await cancellationBodyStarted;
      controller.abort(new Error('test cancellation'));
      await assert.rejects(cancelled, /abort|cancel/i);
      assert.equal(fetchCount, 2);

      for (const directory of ['timeout-output', 'cancel-output']) {
        const files = await readdir(join(cwd, directory)).catch(error => {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return [];
          throw error;
        });
        assert.deepEqual(files, []);
      }
    } finally {
      globalThis.fetch = originalFetch;
      restoreEnvironmentVariable('ELEVENLABS_API_KEY', originalApiKey);
      await rm(cwd, {recursive: true, force: true});
    }
  },
);
