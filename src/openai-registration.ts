import {randomUUID} from 'node:crypto';
import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {dirname, join} from 'node:path';
import lockfile from 'proper-lockfile';
import type {
  CreateModelRuntimeOptions,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import type {
  Credential,
  CredentialStore,
  LoginOptions,
  ProviderAuthInteraction,
} from '@earendil-works/pi-ai';

interface RegistrationOptions extends LoginOptions {
  openaiRegistration: {
    load(interaction: ProviderAuthInteraction): Promise<string | undefined>;
    save(clientId: string): Promise<void>;
  };
}

function isClientId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    value.trim() === value &&
    value !== 'dynamic_agent_client'
  );
}

async function readJSON(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Could not read OpenAI registration storage: ${path}`, {
      cause: error,
    });
  }
}

/** Registration IDs outlive tokens and never appear as signed-in credentials. */
class OpenAIRegistrations {
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  async list(): Promise<string[]> {
    const data = await readJSON(this.path);
    if (data === undefined) return [];
    if (
      !data ||
      typeof data !== 'object' ||
      !('version' in data) ||
      data.version !== 1 ||
      !('clientIds' in data) ||
      !Array.isArray(data.clientIds) ||
      !data.clientIds.every(isClientId)
    )
      throw new Error('Invalid saved OpenAI registrations.');
    return [...new Set(data.clientIds)];
  }

  async save(clientId: string): Promise<void> {
    if (!isClientId(clientId)) throw new Error('Invalid OpenAI client ID.');
    await mkdir(dirname(this.path), {recursive: true, mode: 0o700});
    let compromised: Error | undefined;
    const release = await lockfile.lock(this.path, {
      realpath: false,
      retries: {retries: 10, minTimeout: 20, maxTimeout: 200},
      onCompromised: error => {
        compromised = error;
      },
    });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      const clientIds = await this.list();
      if (clientIds.includes(clientId)) return;
      clientIds.push(clientId);
      await writeFile(
        temporary,
        JSON.stringify({version: 1, clientIds}) + '\n',
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      if (compromised) throw compromised;
      await rename(temporary, this.path);
    } finally {
      try {
        await rm(temporary, {force: true});
      } finally {
        if (!compromised) await release();
      }
    }
  }
}

/** Migrate an existing registration before its tokens can be removed or replaced. */
export async function preserveOpenAIRegistration(
  authPath: string,
  signal?: AbortSignal,
  credentials?: CredentialStore,
): Promise<string | undefined> {
  signal?.throwIfAborted();
  let credential: Credential | undefined;
  if (credentials) {
    credential = await credentials.read('openai', {signal});
  } else {
    const data = await readJSON(authPath);
    if (data !== undefined) {
      if (!data || typeof data !== 'object' || Array.isArray(data))
        throw new Error('Invalid credential storage.');
      credential = (data as Record<string, Credential>).openai;
    }
  }
  if (credential?.type === 'oauth' && isClientId(credential.clientId)) {
    await new OpenAIRegistrations(
      join(dirname(authPath), 'openai-registrations.json'),
    ).save(credential.clientId);
    signal?.throwIfAborted();
    return credential.clientId;
  }
  return undefined;
}

const installed = new WeakSet<ModelRuntime>();

/** Supply durable registration context to the patched Pi flow for every app login entry point. */
export function installOpenAIRegistrationReuse(
  runtime: ModelRuntime,
  options: CreateModelRuntimeOptions & {authPath: string},
): void {
  if (installed.has(runtime)) return;
  installed.add(runtime);
  const authPath = options.authPath;
  const registrations = new OpenAIRegistrations(
    join(dirname(authPath), 'openai-registrations.json'),
  );
  const supportsReuse = () => {
    const login = runtime.getProvider('openai')?.auth.oauth?.login;
    return Boolean(
      login &&
      'varisdevRegistrationReuse' in login &&
      login.varisdevRegistrationReuse === true,
    );
  };
  const rememberCurrent = (signal?: AbortSignal) =>
    preserveOpenAIRegistration(authPath, signal, options.credentials);
  const login = runtime.login.bind(runtime);
  runtime.login = async (provider, type, interaction, loginOptions) => {
    if (provider !== 'openai' || !supportsReuse())
      return login(provider, type, interaction, loginOptions);
    if (type !== 'oauth') {
      await rememberCurrent(interaction.signal);
      return login(provider, type, interaction, loginOptions);
    }
    const registrationOptions: RegistrationOptions = {
      ...loginOptions,
      agentName: loginOptions?.agentName ?? 'VarisDev',
      openaiRegistration: {
        async load(interaction) {
          const current = await rememberCurrent(interaction.signal);
          const clientIds = await registrations.list();
          interaction.signal.throwIfAborted();
          if (!clientIds.length) return undefined;
          const choices = clientIds.map((id, index) => ({
            id,
            label:
              clientIds.length === 1
                ? 'Continue with saved ChatGPT connection'
                : `Saved connection ${index + 1}${id === current ? ' (current)' : ''}`,
          }));
          choices.sort(
            (a, b) => Number(b.id === current) - Number(a.id === current),
          );
          const selected = await interaction.prompt({
            type: 'select',
            message: 'Choose a ChatGPT connection',
            options: [
              ...choices,
              {id: 'new', label: 'Connect another account or workspace'},
            ],
          });
          interaction.signal.throwIfAborted();
          if (selected === 'new') return undefined;
          if (!clientIds.includes(selected))
            throw new Error('Choose a saved ChatGPT connection.');
          return selected;
        },
        save: clientId => registrations.save(clientId),
      },
    };
    return login(provider, type, interaction, registrationOptions);
  };
  const logout = runtime.logout.bind(runtime);
  runtime.logout = async (provider, logoutOptions) => {
    if (provider === 'openai' && supportsReuse())
      await rememberCurrent(logoutOptions?.signal);
    return logout(provider, logoutOptions);
  };
}
