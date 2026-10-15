import {join} from 'node:path';
import {
  getAgentDir,
  SettingsManager,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import {
  clampThinkingLevel,
  getSupportedThinkingLevels,
} from '@earendil-works/pi-ai';
import {sessionConfiguration} from '../dashboard/hub.ts';
import {createDesktopModelRuntime} from '../llama.ts';

export interface ModelDefaultsState {
  model?: {provider: string; id: string};
  thinkingLevel: string;
  models: Array<{
    provider: string;
    id: string;
    name: string;
    thinkingLevels: string[];
  }>;
}

type DefaultsRuntime = Pick<ModelRuntime, 'refresh' | 'getModels'>;

/** Startup preferences belong to the app, not to any selected conversation. */
export class DesktopModelDefaults {
  private runtime?: Promise<DefaultsRuntime>;
  private saving: Promise<unknown> = Promise.resolve();
  private readonly createRuntime?: () => Promise<DefaultsRuntime>;

  constructor(createRuntime?: () => Promise<DefaultsRuntime>) {
    this.createRuntime = createRuntime;
  }

  private async models() {
    this.runtime ??= (
      this.createRuntime
        ? this.createRuntime()
        : createDesktopModelRuntime({
            authPath: join(getAgentDir(), 'auth.json'),
            modelsPath: join(getAgentDir(), 'models.json'),
            allowModelNetwork: false,
          })
    ).catch(error => {
      this.runtime = undefined;
      throw error;
    });
    const runtime = await this.runtime;
    await runtime.refresh({allowNetwork: false});
    return runtime.getModels();
  }

  private settings(): SettingsManager {
    // Never merge the selected folder's settings into the app-wide editor.
    const settings = SettingsManager.create(getAgentDir(), getAgentDir(), {
      projectTrusted: false,
    });
    this.checkErrors(settings);
    return settings;
  }

  private checkErrors(settings: SettingsManager): void {
    const errors = settings.drainErrors();
    if (errors.length)
      throw new Error(
        `Could not access model defaults: ${errors[0].error.message}`,
      );
  }

  private async read(): Promise<ModelDefaultsState> {
    const models = await this.models();
    const settings = this.settings();
    const provider = settings.getDefaultProvider();
    const id = settings.getDefaultModel();
    const saved = provider && id ? {provider, id} : undefined;
    const model = models.find(
      item => item.provider === saved?.provider && item.id === saved.id,
    );
    const level =
      (saved && settings.getModelThinkingLevel(saved.provider, saved.id)) ??
      settings.getDefaultThinkingLevel() ??
      'medium';
    return {
      model: saved,
      thinkingLevel: model ? clampThinkingLevel(model, level) : level,
      models: models.map(model => ({
        provider: model.provider,
        id: model.id,
        name: model.name,
        thinkingLevels: getSupportedThinkingLevels(model),
      })),
    };
  }

  async get(): Promise<ModelDefaultsState> {
    await this.saving;
    return this.read();
  }

  save(input: unknown): Promise<ModelDefaultsState> {
    const operation = this.saving.then(async () => {
      const values = sessionConfiguration(input);
      if (!values.provider || !values.modelId || !values.thinkingLevel)
        throw new Error('Choose a default model and thinking level.');
      const model = (await this.models()).find(
        item => item.provider === values.provider && item.id === values.modelId,
      );
      if (!model)
        throw new Error(
          'This model is unavailable. Choose a model from the catalog.',
        );
      const levels = getSupportedThinkingLevels(model);
      const level = values.thinkingLevel as (typeof levels)[number];
      if (!levels.includes(level))
        throw new Error(`Thinking level must be one of: ${levels.join(', ')}.`);
      const settings = this.settings();
      settings.setDefaultModelAndProvider(model.provider, model.id);
      settings.setDefaultThinkingLevel(level);
      // An existing per-model override must not undo the effort just saved here.
      if (
        settings.getModelThinkingLevel(model.provider, model.id) !== undefined
      )
        settings.setModelThinkingLevel(model.provider, model.id, level);
      await settings.flush();
      this.checkErrors(settings);
      return this.read();
    });
    this.saving = operation.catch(() => {});
    return operation;
  }
}
