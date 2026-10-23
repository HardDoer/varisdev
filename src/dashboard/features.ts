import type {AgentMentionCandidate} from '../agents/mentions.ts';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai';
import {
  createDefaultAgentProfile,
  type AgentTemplate,
} from '../agents/templates.ts';
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ResourceLoader,
  SettingsManager,
  SessionManager,
} from '@earendil-works/pi-coding-agent';
import {loaderContextFiles} from './context-files.ts';
import {nativeCommands} from './command-catalog.mjs';
import {speedModeFeatures, type SpeedMode} from '../speed-modes.ts';

// Use the public entry so Pi can supply its API through the extension loader.
export function supportedThinkingLevels(
  model: NonNullable<CreateAgentSessionOptions['model']>,
): string[] {
  return getSupportedThinkingLevels(model);
}

export interface SessionFeatures {
  agentMentions?: AgentMentionCandidate[];
  agentProfile?: Pick<AgentTemplate, 'id' | 'name' | 'mode' | 'color'>;
  contextFiles?: Array<{
    path: string;
    name: string;
    kind:
      'instructions' | 'system' | 'append' | 'skill' | 'template' | 'document';
    status: 'included' | 'available';
    description: string;
    content?: string;
  }>;
  commands: Array<{
    name: string;
    description: string;
    source: 'skill' | 'prompt' | 'extension' | 'builtin';
    path?: string;
  }>;
  models: Array<{id: string; provider: string; name: string}>;
  scopedModels?: Array<{
    model: {id: string; provider: string; name: string};
    thinkingLevel?: string;
  }>;
  model?: {id: string; provider: string};
  thinkingLevel: string;
  thinkingLevels: string[];
  speedMode?: SpeedMode;
  speedModes?: SpeedMode[];
  tools: Array<{name: string; description: string}>;
  diagnostics: Array<{message: string; path?: string}>;
}

export function agentProfileSummary(
  profile: AgentTemplate,
): NonNullable<SessionFeatures['agentProfile']> {
  const {id, name, mode, color} = profile;
  return {id, name, mode, ...(color !== undefined ? {color} : {})};
}

export function sessionAgentProfile(
  manager: Pick<SessionManager, 'getEntries'>,
): NonNullable<SessionFeatures['agentProfile']> {
  const saved = manager
    .getEntries?.()
    .findLast(
      entry =>
        entry.type === 'custom' &&
        entry.customType === 'varisdev.agent-profile',
    );
  const profile =
    saved?.type === 'custom'
      ? (saved.data as AgentTemplate | undefined)
      : undefined;
  return agentProfileSummary(profile ?? createDefaultAgentProfile());
}

export interface SessionConfiguration {
  persist?: boolean;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
}

export const desktopCommands: SessionFeatures['commands'] = nativeCommands.map(
  ({name, description}) => ({name, description, source: 'builtin'}),
);

export function sessionFeatures(
  session: AgentSession,
  loader: ResourceLoader,
  settings: SettingsManager,
  diagnostics: SessionFeatures['diagnostics'] = [],
): SessionFeatures {
  const skills = loader.getSkills();
  const prompts = loader.getPrompts();
  const extensions = loader.getExtensions();
  const runner = session.extensionRunner;
  return {
    agentProfile: sessionAgentProfile(session.sessionManager),
    contextFiles: loaderContextFiles(
      loader,
      session.getActiveToolNames(),
      session.sessionManager.buildSessionContext().messages,
      session.sessionManager.getCwd(),
    ),
    commands: [
      ...desktopCommands.map(command => ({...command})),
      ...runner
        .getRegisteredCommands()
        .map(command => ({
          name: command.invocationName,
          description: command.description ?? '',
          source: 'extension' as const,
          path: command.sourceInfo.path,
        }))
        .filter(
          command =>
            !desktopCommands.some(builtin => builtin.name === command.name),
        ),
      ...prompts.prompts.map(prompt => ({
        name: prompt.name,
        description: prompt.description,
        source: 'prompt' as const,
        path: prompt.filePath,
      })),
      ...(settings.getEnableSkillCommands()
        ? skills.skills.map(skill => ({
            name: `skill:${skill.name}`,
            description: skill.description,
            source: 'skill' as const,
            path: skill.filePath,
          }))
        : []),
    ],
    models: runner
      .getModelRegistry()
      .getAvailable()
      .map(model => ({
        id: model.id,
        provider: model.provider,
        name: model.name,
      })),
    scopedModels: session.scopedModels.map(({model, thinkingLevel}) => ({
      model: {id: model.id, provider: model.provider, name: model.name},
      ...(thinkingLevel !== undefined ? {thinkingLevel} : {}),
    })),
    ...(session.model
      ? {model: {id: session.model.id, provider: session.model.provider}}
      : {}),
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels(),
    ...speedModeFeatures(runner.createContext()),
    tools: session
      .getAllTools()
      .map(tool => ({name: tool.name, description: tool.description})),
    diagnostics: [
      ...skills.diagnostics,
      ...prompts.diagnostics,
      ...loader.getThemes().diagnostics,
      ...runner.getCommandDiagnostics(),
      ...extensions.errors.map(error => ({
        message: error.error,
        path: error.path,
      })),
      ...diagnostics,
    ].map(({message, path}) => ({message, ...(path ? {path} : {})})),
  };
}
