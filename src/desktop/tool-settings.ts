import type {ModelRuntime} from '@earendil-works/pi-coding-agent';
import {createGlobalModelRuntime} from './model-runtime.ts';
import {
  readToolSettings,
  saveToolSettings,
  type ToolSettings,
} from '../tools/settings.ts';

export interface ToolSettingsModel {
  provider: string;
  id: string;
  name: string;
}

export interface ToolSettingsState {
  settings: ToolSettings;
  models: ToolSettingsModel[];
  diagnostics?: string[];
}

interface ToolSettingsDependencies {
  sessionFeatures: (
    sessionId: string,
  ) => Promise<{models: ToolSettingsModel[]}>;
  createRuntime?: () => Promise<Pick<ModelRuntime, 'refresh' | 'getModels'>>;
}

/** Tool preferences use the selected session's registry, including extensions. */
export class DesktopToolSettings {
  private runtime?: Promise<Pick<ModelRuntime, 'refresh' | 'getModels'>>;
  private readonly diagnostics = new Set<string>();
  private saving: Promise<unknown> = Promise.resolve();
  private readonly dependencies: ToolSettingsDependencies;

  constructor(dependencies: ToolSettingsDependencies) {
    this.dependencies = dependencies;
  }

  private async models(sessionId?: string): Promise<ToolSettingsModel[]> {
    let models: readonly ToolSettingsModel[];
    if (sessionId !== undefined) {
      models = (await this.dependencies.sessionFeatures(sessionId)).models;
    } else {
      if (!this.runtime) {
        this.diagnostics.clear();
        this.runtime = (
          this.dependencies.createRuntime
            ? this.dependencies.createRuntime()
            : createGlobalModelRuntime(message => this.diagnostics.add(message))
        ).catch(error => {
          this.runtime = undefined;
          throw error;
        });
      }
      const runtime = await this.runtime;
      await runtime.refresh({allowNetwork: false});
      models = runtime.getModels();
    }
    return models.map(({provider, id, name}) => ({provider, id, name}));
  }

  async getToolSettings(sessionId?: string): Promise<ToolSettingsState> {
    const models = await this.models(sessionId);
    return {
      settings: await readToolSettings(),
      models,
      ...(sessionId === undefined && this.diagnostics.size
        ? {diagnostics: [...this.diagnostics]}
        : {}),
    };
  }

  saveToolSettings(
    section: unknown,
    value: unknown,
    sessionId?: string,
  ): Promise<ToolSettingsState> {
    const operation = this.saving.then(async () => {
      const {settings, models, diagnostics} =
        await this.getToolSettings(sessionId);
      const known = new Set(
        models.map(model => `${model.provider}/${model.id}`),
      );
      // Persistence validates the complete IPC shape and cross-section rules.
      // Check catalog membership only for strings that could be new selections.
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const input = value as Record<string, unknown>;
        const selected =
          section === 'agents' && Array.isArray(input.allowedModels)
            ? input.allowedModels
            : section === 'commit'
              ? [input.model]
              : [];
        const previous =
          section === 'agents'
            ? (settings.agents.allowedModels ?? [])
            : [settings.commit.model];
        for (const model of selected) {
          if (
            typeof model === 'string' &&
            !known.has(model) &&
            !previous.includes(model)
          )
            throw new Error(
              `Unknown model: ${model}. Choose a model from the catalog.`,
            );
        }
      }
      await saveToolSettings(section, value);
      return {
        settings: await readToolSettings(),
        models,
        ...(diagnostics ? {diagnostics} : {}),
      };
    });
    this.saving = operation.catch(() => {});
    return operation;
  }
}
