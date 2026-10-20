import {
  getAgentDir,
  resolveModelScopeWithDiagnostics,
  SettingsManager,
  type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import {createGlobalModelRuntime} from './model-runtime.ts';
import {
  parseToolSettingsUpdate,
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
  sessionFeatures: (sessionId: string) => Promise<{
    models: ToolSettingsModel[];
    scopedModels?: Array<{
      model: ToolSettingsModel;
      thinkingLevel?: string;
    }>;
  }>;
  createRuntime?: () => Promise<ModelRuntime>;
}

/** Model choices follow Pi's active session scope or its saved global scope. */
export class DesktopToolSettings {
  private runtime?: Promise<ModelRuntime>;
  private readonly diagnostics = new Set<string>();
  private saving: Promise<unknown> = Promise.resolve();
  private readonly dependencies: ToolSettingsDependencies;

  constructor(dependencies: ToolSettingsDependencies) {
    this.dependencies = dependencies;
  }

  private async catalog(sessionId?: string): Promise<{
    models: ToolSettingsModel[];
    diagnostics?: string[];
  }> {
    let models: readonly ToolSettingsModel[];
    let diagnostics: string[] = [];
    if (sessionId !== undefined) {
      const features = await this.dependencies.sessionFeatures(sessionId);
      models = features.scopedModels?.length
        ? features.scopedModels.map(scoped => scoped.model)
        : features.models;
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
      const agentDir = getAgentDir();
      const settings = SettingsManager.create(agentDir, agentDir, {
        projectTrusted: false,
      });
      const patterns = settings.getEnabledModels();
      const scope = patterns?.length
        ? await resolveModelScopeWithDiagnostics(patterns, runtime)
        : undefined;
      models = scope?.scopedModels.length
        ? scope.scopedModels.map(scoped => scoped.model)
        : runtime.getAvailableSnapshot();
      diagnostics = [
        ...this.diagnostics,
        ...settings.drainErrors().map(diagnostic => diagnostic.error.message),
        ...(scope?.diagnostics.map(diagnostic => diagnostic.message) ?? []),
      ];
    }
    return {
      models: models.map(({provider, id, name}) => ({provider, id, name})),
      ...(diagnostics.length ? {diagnostics} : {}),
    };
  }

  async getToolSettings(sessionId?: string): Promise<ToolSettingsState> {
    const catalog = await this.catalog(sessionId);
    return {settings: await readToolSettings(), ...catalog};
  }

  async saveToolSettings(
    section: unknown,
    value: unknown,
    sessionId?: string,
  ): Promise<ToolSettingsState> {
    const update = parseToolSettingsUpdate(section, value);
    const operation = this.saving.then(async () => {
      const {settings, models, diagnostics} =
        await this.getToolSettings(sessionId);
      const known = new Set(
        models.map(model => `${model.provider}/${model.id}`),
      );
      const assertKnown = (
        selected: Array<string | null>,
        previous: Array<string | null>,
      ) => {
        for (const model of selected) {
          if (model !== null && !known.has(model) && !previous.includes(model))
            throw new Error(
              `Unknown model: ${model}. Choose a model from the catalog.`,
            );
        }
      };
      if (update.agents)
        assertKnown(
          update.agents.allowedModels ?? [],
          settings.agents.allowedModels ?? [],
        );
      await saveToolSettings(
        section,
        section === 'all' ? update : update.agents,
      );
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
