import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {
  getPackageDir,
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from '@earendil-works/pi-coding-agent';
import type {Provider} from '@earendil-works/pi-ai';

export const LLAMA_PROVIDER = 'llama.cpp';

export interface LlamaModel {
  id: string;
  status: {value: string; failed?: boolean};
}
export interface LlamaProgress {
  message: string;
  ratio?: number;
  detail?: string;
}
export interface LlamaClient {
  serverUrl: string;
  list(options?: {signal?: AbortSignal}): Promise<LlamaModel[]>;
  unload(model: string, signal?: AbortSignal): Promise<void>;
  unloadAndWait(model: string, signal?: AbortSignal): Promise<void>;
  loadAndWait(
    model: string,
    progress: (value: LlamaProgress) => void,
    signal?: AbortSignal,
  ): Promise<LlamaModel>;
  downloadAndWait(
    model: string,
    progress: (value: LlamaProgress) => void,
    signal?: AbortSignal,
  ): Promise<LlamaModel[]>;
}
interface HuggingFaceClient {
  search(query: string, signal?: AbortSignal): Promise<Array<{id: string}>>;
  details(
    id: string,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    gated: false | 'auto' | 'manual';
    quantizations: Array<{name: string; size?: number}>;
  }>;
}
interface LlamaModules {
  createLlamaProvider(): {provider: Provider<'openai-completions'>};
  LlamaClient: new (url: string, apiKey?: string) => LlamaClient;
  normalizeLlamaServerUrl(url: string): string;
  formatBytes(bytes: number): string;
  HuggingFaceClient: new (token?: string) => HuggingFaceClient;
  findHuggingFaceToken(): Promise<string | undefined>;
}
let modules: Promise<LlamaModules> | undefined;

/** Pi ships these modules with its pinned runtime but does not export them in its SDK. */
export function llamaModules(): Promise<LlamaModules> {
  modules ??= Promise.all(
    ['provider', 'client', 'huggingface'].map(
      name =>
        import(
          pathToFileURL(
            join(getPackageDir(), 'dist/extensions/llama', `${name}.js`),
          ).href
        ),
    ),
  ).then(([provider, client, huggingFace]) => ({
    ...provider,
    ...client,
    ...huggingFace,
  }));
  return modules;
}

export async function createDesktopModelRuntime(
  options: CreateModelRuntimeOptions,
): Promise<ModelRuntime> {
  const runtime = await ModelRuntime.create(options);
  const {createLlamaProvider} = await llamaModules();
  runtime.registerNativeProvider(createLlamaProvider().provider);
  await runtime.refresh({providers: [LLAMA_PROVIDER], allowNetwork: false});
  return runtime;
}
