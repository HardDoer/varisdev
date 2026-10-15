import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {getAgentDir, type ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createDesktopModelRuntime, LLAMA_PROVIDER} from '../llama.ts';
import type {AuthEvent, AuthPrompt, AuthType} from '@earendil-works/pi-ai';
import {updateMessage} from './updates.ts';

export interface AccountState {
  revision: number;
  providers: Array<{
    id: string;
    name: string;
    oauth: boolean;
    apiKey: boolean;
    stored: boolean;
    status: string;
  }>;
  attempt?: {id: string; provider: string};
  prompt?: {
    id: string;
    type: AuthPrompt['type'];
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
    options?: Array<{id: string; label: string}>;
  };
  message: string;
  error?: string;
  links: Array<{url: string; label: string}>;
  deviceCode?: string;
}

interface AccountDependencies {
  createRuntime?: () => Promise<ModelRuntime>;
  openBrowser: (url: string) => Promise<void>;
  changed: (state: AccountState) => void;
}

/** App-wide provider authentication, independent of any open parent session. */
export class DesktopAccounts {
  private runtime?: Promise<ModelRuntime>;
  private readonly state: AccountState = {
    revision: 0,
    providers: [],
    message: '',
    links: [],
  };
  private controller?: AbortController;
  private operation?: Promise<void>;
  private pending?: {id: string; finish: (value: string) => void};
  private disposed = false;
  private readonly secrets = new Set<string>();

  private readonly dependencies: AccountDependencies;

  constructor(dependencies: AccountDependencies) {
    this.dependencies = dependencies;
  }

  private getRuntime(): Promise<ModelRuntime> {
    this.runtime ??= (
      this.dependencies.createRuntime
        ? this.dependencies.createRuntime()
        : createDesktopModelRuntime({
            authPath: join(getAgentDir(), 'auth.json'),
            modelsPath: join(getAgentDir(), 'models.json'),
            allowModelNetwork: false,
          })
    ).catch(error => {
      this.runtime = undefined;
      throw error;
    });
    return this.runtime;
  }

  snapshot(): AccountState {
    return structuredClone(this.state);
  }

  private clean(text: string): string {
    for (const secret of this.secrets)
      text = text.split(secret).join('[redacted]');
    return updateMessage(text).slice(0, 8000);
  }

  private publish(): void {
    this.state.revision++;
    if (!this.disposed) this.dependencies.changed(this.snapshot());
  }

  private async providers(): Promise<void> {
    const runtime = await this.getRuntime();
    await runtime.refresh({allowNetwork: false});
    const stored = new Map(
      (await runtime.listCredentials()).map(item => [
        item.providerId,
        item.type,
      ]),
    );
    this.state.providers = runtime
      .getProviders()
      .map(provider => {
        const auth = runtime.getProviderAuthStatus(provider.id);
        const credential = stored.get(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          oauth: Boolean(provider.auth.oauth),
          apiKey: Boolean(provider.auth.apiKey?.login),
          stored: stored.has(provider.id),
          status:
            credential === 'oauth'
              ? 'Signed in'
              : credential === 'api_key'
                ? provider.id === LLAMA_PROVIDER
                  ? 'Server configured'
                  : 'API key saved'
                : auth.configured
                  ? auth.source === 'environment'
                    ? 'Configured in environment'
                    : 'Configured'
                  : 'Not connected',
        };
      })
      .filter(
        provider =>
          provider.oauth ||
          provider.apiKey ||
          provider.stored ||
          provider.status !== 'Not connected',
      )
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(): Promise<AccountState> {
    await this.providers();
    this.publish();
    return this.snapshot();
  }

  start(providerId: unknown, method: unknown): AccountState {
    if (method !== 'oauth' && method !== 'api_key' && method !== 'logout')
      throw new Error('Choose a sign-in method.');
    if (
      typeof providerId !== 'string' ||
      !providerId ||
      providerId.length > 256
    )
      throw new Error('Choose a provider.');
    if (this.disposed) throw new Error('The accounts window is unavailable.');
    if (this.operation)
      throw new Error('Finish or cancel the current account operation.');
    const controller = new AbortController();
    this.controller = controller;
    this.secrets.clear();
    this.state.attempt = {id: randomUUID(), provider: providerId};
    this.state.message = method === 'logout' ? 'Signing out…' : 'Connecting…';
    this.state.error = undefined;
    this.state.links = [];
    this.state.deviceCode = undefined;
    this.publish();
    this.operation = this.run(providerId, method, controller).finally(() => {
      this.operation = undefined;
      this.controller = undefined;
      this.pending = undefined;
      this.state.attempt = undefined;
      this.state.prompt = undefined;
      this.state.links = [];
      this.state.deviceCode = undefined;
      this.secrets.clear();
      this.publish();
    });
    return this.snapshot();
  }

  private async run(
    providerId: string,
    method: AuthType | 'logout',
    controller: AbortController,
  ): Promise<void> {
    const {signal} = controller;
    try {
      const runtime = await this.getRuntime();
      signal.throwIfAborted();
      const provider = runtime.getProvider(providerId);
      if (!provider) throw new Error('This provider is unavailable.');
      if (method === 'logout') {
        await runtime.logout(providerId, {signal});
        this.state.error = undefined;
        this.state.message = `Signed out of ${provider.name}.`;
      } else {
        if (
          !(method === 'oauth'
            ? provider.auth.oauth
            : provider.auth.apiKey?.login)
        )
          throw new Error(
            'This provider does not support that sign-in method.',
          );
        await runtime.login(providerId, method, {
          signal,
          prompt: request => this.prompt(request, signal),
          notify: event => {
            if (!signal.aborted) this.notify(event);
          },
        });
        this.state.error = undefined;
        this.state.message =
          providerId === LLAMA_PROVIDER
            ? 'Connected to llama.cpp.'
            : method === 'api_key'
              ? `API key saved for ${provider.name}.`
              : `Signed in to ${provider.name}.`;
      }
    } catch (error) {
      this.state.message = signal.aborted
        ? 'Cancelled.'
        : 'Account setup failed.';
      this.state.error = signal.aborted
        ? undefined
        : this.clean(error instanceof Error ? error.message : String(error));
    }
    try {
      await this.providers();
    } catch (error) {
      this.state.error = this.clean(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private prompt(
    request: AuthPrompt,
    loginSignal: AbortSignal,
  ): Promise<string> {
    const signal = request.signal
      ? AbortSignal.any([request.signal, loginSignal])
      : loginSignal;
    signal.throwIfAborted();
    if (this.pending)
      throw new Error('The provider requested overlapping account prompts.');
    const id = randomUUID();
    // Pi's llama.cpp login accepts the default URL and an optional server key.
    const allowEmpty =
      this.state.attempt?.provider === LLAMA_PROVIDER &&
      (request.type === 'text' || request.type === 'secret');
    return new Promise((resolve, reject) => {
      const clear = () => {
        signal.removeEventListener('abort', abort);
        if (this.pending?.id === id) {
          this.pending = undefined;
          this.state.prompt = undefined;
          this.publish();
        }
      };
      const abort = () => {
        clear();
        reject(signal.reason);
      };
      this.pending = {
        id,
        finish: value => {
          if (
            request.type === 'select' &&
            !request.options.some(option => option.id === value)
          )
            throw new Error('Choose one of the listed options.');
          if (!allowEmpty && !value.trim())
            throw new Error('A value is required.');
          if (request.type === 'secret' || request.type === 'manual_code')
            this.secrets.add(value);
          clear();
          resolve(value);
        },
      };
      this.state.prompt = {
        id,
        type: request.type,
        message: this.clean(request.message),
        ...(allowEmpty ? {allowEmpty: true} : {}),
        ...('placeholder' in request ? {placeholder: request.placeholder} : {}),
        ...(request.type === 'select'
          ? {
              options: request.options.map(option => ({
                id: option.id,
                label: this.clean(option.label),
              })),
            }
          : {}),
      };
      signal.addEventListener('abort', abort, {once: true});
      this.publish();
    });
  }

  respond(attemptId: unknown, promptId: unknown, value: unknown): void {
    if (
      !this.state.attempt ||
      this.state.attempt.id !== attemptId ||
      !this.pending ||
      this.pending.id !== promptId
    )
      throw new Error('This account prompt has ended.');
    if (typeof value !== 'string' || value.length > 16384)
      throw new Error('Enter a response of up to 16384 characters.');
    this.pending.finish(value);
  }

  cancel(attemptId: unknown): void {
    if (this.state.attempt?.id === attemptId) this.controller?.abort();
  }

  private addLink(url: string, label: string): boolean {
    try {
      const parsed = new URL(url);
      if (
        !['https:', 'http:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password
      )
        return false;
    } catch {
      return false;
    }
    if (url.length > 16384 || this.state.links.some(link => link.url === url))
      return false;
    this.state.links = [
      ...this.state.links,
      {url, label: this.clean(label)},
    ].slice(-10);
    return true;
  }

  private notify(event: AuthEvent): void {
    if (event.type === 'auth_url') {
      this.state.message = this.clean(
        event.instructions || 'Continue signing in through your browser.',
      );
      if (this.addLink(event.url, 'Open sign-in page'))
        this.launchBrowser(event.url);
    } else if (event.type === 'device_code') {
      this.state.deviceCode = event.userCode;
      this.state.message = 'Enter this code on the sign-in page.';
      if (this.addLink(event.verificationUri, 'Open sign-in page'))
        this.launchBrowser(event.verificationUri);
    } else {
      this.state.message = this.clean(event.message);
      if (event.type === 'info')
        for (const link of event.links ?? [])
          this.addLink(link.url, link.label || 'Open provider page');
    }
    this.publish();
  }

  private launchBrowser(url: string): void {
    const attemptId = this.state.attempt?.id;
    void this.dependencies.openBrowser(url).catch(() => {
      if (!this.disposed && this.state.attempt?.id === attemptId) {
        this.state.error =
          'Could not open the browser. Try the sign-in page button again.';
        this.publish();
      }
    });
  }

  async openLink(attemptId: unknown, index: unknown): Promise<void> {
    if (
      !this.state.attempt ||
      this.state.attempt.id !== attemptId ||
      !Number.isInteger(index)
    )
      throw new Error('This sign-in link has expired.');
    const link = this.state.links[index as number];
    if (!link) throw new Error('Choose a sign-in link.');
    await this.dependencies.openBrowser(link.url);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.controller?.abort();
    await this.operation;
  }
}
