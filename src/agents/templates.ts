import {
  CONFIG_DIR_NAME,
  getAgentDir,
  parseFrontmatter,
  SettingsManager,
  withFileMutationQueue,
} from '@earendil-works/pi-coding-agent';
import {randomUUID} from 'node:crypto';
import {
  builtinAgentsDirectory,
  builtinCommitAgentsDirectory,
} from '../builtin-assets.ts';
import {createDefaultAgentProfile} from './default.ts';
export {createDefaultAgentProfile} from './default.ts';
import {
  createWorkspaceConfiguration,
  workspaceConfigPaths,
} from '../dashboard/workspace-config.ts';
import {existsSync, realpathSync} from 'node:fs';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';

export type AgentTemplateScope =
  'builtin' | 'global' | 'repository' | 'workspace';
export type WritableAgentTemplateScope = Exclude<AgentTemplateScope, 'builtin'>;
export type AgentTemplateThinkingLevel =
  'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type AgentMode = 'primary' | 'subagent' | 'all';
export type AgentContextScope = 'workspace' | 'task';
export type AgentPermissionEffect = 'allow' | 'ask' | 'deny';

export interface AgentPermissionRule {
  action: string;
  resource: string;
  effect: AgentPermissionEffect;
}

/** One Markdown file as authored in a particular scope. */
export interface AgentTemplateDefinition {
  id: string;
  /** Stable scoped key accepted by resolveAgentTemplate. */
  key: string;
  name?: string;
  description?: string;
  instructions: string;
  mode?: AgentMode;
  context?: AgentContextScope;
  model?: string;
  thinkingLevel?: AgentTemplateThinkingLevel;
  hidden?: boolean;
  disabled?: boolean;
  color?: string;
  steps?: number;
  permissions?: AgentPermissionRule[];
  scope: AgentTemplateScope;
  sourcePath: string;
}

/** Effective profile after lower-precedence definitions have been merged. */
export interface AgentTemplate {
  id: string;
  key: string;
  name: string;
  description?: string;
  instructions: string;
  mode: AgentMode;
  context: AgentContextScope;
  model?: string;
  thinkingLevel?: AgentTemplateThinkingLevel;
  hidden: boolean;
  disabled: boolean;
  color?: string;
  steps?: number;
  permissions: AgentPermissionRule[];
  /** Marks shared settings permissions as already prepended to this snapshot. */
  permissionsVersion?: 1;
  scope: AgentTemplateScope;
  sourcePath: string;
}

export interface AgentTemplateDiagnostic {
  scope: AgentTemplateScope;
  sourcePath: string;
  message: string;
}

export interface AgentTemplateSource {
  scope: AgentTemplateScope;
  directory: string;
  /** Raw definitions, including definitions shadowed by a higher scope. */
  templates: AgentTemplateDefinition[];
}

export interface AgentTemplateList {
  /** Effective enabled profiles. Hidden profiles remain available for direct use. */
  templates: AgentTemplate[];
  /** Raw definitions used by configuration editors. */
  allTemplates: AgentTemplateDefinition[];
  sources: AgentTemplateSource[];
  diagnostics: AgentTemplateDiagnostic[];
  /** Selected default: configured primary agent, Default, or builtin:default. */
  defaultAgentId?: string;
}

export interface SaveAgentTemplateInput {
  scope: WritableAgentTemplateScope;
  id: string;
  name?: string;
  description?: string;
  instructions?: string;
  mode?: AgentMode;
  context?: AgentContextScope;
  model?: string;
  thinkingLevel?: AgentTemplateThinkingLevel;
  hidden?: boolean;
  disabled?: boolean;
  color?: string;
  steps?: number;
  permissions?: AgentPermissionRule[];
  /** Exact existing raw definition to replace. */
  sourcePath?: string;
}

export interface DeleteAgentTemplateInput {
  scope: WritableAgentTemplateScope;
  id: string;
  /** Exact existing raw definition to delete. */
  sourcePath?: string;
}

interface TemplateFrontmatter extends Record<string, unknown> {
  name?: unknown;
  description?: unknown;
  mode?: unknown;
  context?: unknown;
  model?: unknown;
  thinkingLevel?: unknown;
  hidden?: unknown;
  disabled?: unknown;
  color?: unknown;
  steps?: unknown;
  permissions?: unknown;
}

const scopes: AgentTemplateScope[] = [
  'builtin',
  'global',
  'repository',
  'workspace',
];
const thinkingLevels = new Set<AgentTemplateThinkingLevel>([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const modes = new Set<AgentMode>(['primary', 'subagent', 'all']);
const contextScopes = new Set<AgentContextScope>(['workspace', 'task']);
const permissionEffects = new Set<AgentPermissionEffect>([
  'allow',
  'ask',
  'deny',
]);
const frontmatterKeys = new Set([
  'name',
  'description',
  'mode',
  'context',
  'model',
  'thinkingLevel',
  'hidden',
  'disabled',
  'color',
  'steps',
  'permissions',
]);
const inputKeys = new Set([
  'scope',
  'id',
  ...frontmatterKeys,
  'instructions',
  'sourcePath',
]);
const permissionKeys = new Set(['action', 'resource', 'effect']);
const maxFileBytes = 100_000;
const idSegmentPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const preparedTemplateGet = Symbol('varisdev.agent-template-get');

export interface PreparedAgentTemplateGet {
  readonly sourcePaths: readonly string[];
  readonly value: AgentTemplate | AgentTemplateDefinition;
}

interface CachedAgentTemplateGet extends PreparedAgentTemplateGet {
  readonly signature: string;
}

function scopedKey(scope: AgentTemplateScope, id: string): string {
  return `${scope}:${id}`;
}

function validateScope(value: unknown): AgentTemplateScope {
  if (!scopes.includes(value as AgentTemplateScope))
    throw new Error(
      'Agent template scope must be builtin, global, repository, or workspace.',
    );
  return value as AgentTemplateScope;
}

function validateWritableScope(value: unknown): WritableAgentTemplateScope {
  const scope = validateScope(value);
  if (scope === 'builtin')
    throw new Error('Builtin agent templates are read-only.');
  return scope;
}

function validateId(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 160)
    throw new Error(
      'Agent template id must be a lowercase path of filename slugs with 1 to 160 characters.',
    );
  const segments = value.split('/');
  if (
    segments.some(
      segment => !segment || !idSegmentPattern.test(segment) || segment === '.',
    )
  )
    throw new Error(
      'Agent template id must be a lowercase path of filename slugs with 1 to 160 characters.',
    );
  return value;
}

function requiredText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string')
    throw new Error(`Agent template ${label} must be text.`);
  const result = value.trim();
  if (!result || result.length > maximum)
    throw new Error(
      `Agent template ${label} must contain 1 to ${maximum} characters.`,
    );
  return result;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredText(value, label, maximum);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean')
    throw new Error(`Agent template ${label} must be true or false.`);
  return value;
}

function validateMode(value: unknown): AgentMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !modes.has(value as AgentMode))
    throw new Error('Agent template mode must be primary, subagent, or all.');
  return value as AgentMode;
}

function validateContext(value: unknown): AgentContextScope | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    !contextScopes.has(value as AgentContextScope)
  )
    throw new Error('Agent template context must be workspace or task.');
  return value as AgentContextScope;
}

function validateModel(value: unknown): {
  model?: string;
  shorthandThinkingLevel?: AgentTemplateThinkingLevel;
} {
  const raw = optionalText(value, 'model', 512);
  if (raw === undefined) return {};
  let model = raw;
  let shorthandThinkingLevel: AgentTemplateThinkingLevel | undefined;
  const hash = model.lastIndexOf('#');
  if (hash !== -1) {
    const suffix = model.slice(hash + 1);
    if (thinkingLevels.has(suffix as AgentTemplateThinkingLevel)) {
      shorthandThinkingLevel = suffix as AgentTemplateThinkingLevel;
      model = model.slice(0, hash);
    }
  }
  if (/\s|[\p{Cc}\p{Cf}]/u.test(model) || !/^[^/]+\/.+$/u.test(model))
    throw new Error(
      'Agent template model must use provider/model format without whitespace or control characters.',
    );
  return {model, shorthandThinkingLevel};
}

function validateThinkingLevel(
  value: unknown,
): AgentTemplateThinkingLevel | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    !thinkingLevels.has(value as AgentTemplateThinkingLevel)
  )
    throw new Error(
      'Agent template thinkingLevel must be off, minimal, low, medium, high, xhigh, or max.',
    );
  return value as AgentTemplateThinkingLevel;
}

function validateColor(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value))
    throw new Error(
      'Agent template color must be a six-digit hex value such as #ff6b6b.',
    );
  return value.toUpperCase();
}

function validateSteps(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new Error('Agent template steps must be a positive integer.');
  return value as number;
}

function inputFields(
  value: unknown,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Agent template input must be an object.');
  const input = value as Record<string, unknown>;
  const unknown = Object.keys(input).filter(key => !allowed.has(key));
  if (unknown.length)
    throw new Error(`Unknown agent template field: ${unknown.join(', ')}.`);
  return input;
}

function validatePermissions(
  value: unknown,
): AgentPermissionRule[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value))
    throw new Error('Agent template permissions must be an array.');
  return value.map((candidate, index) => {
    const rule = inputFields(candidate, permissionKeys);
    const action = requiredText(
      rule.action,
      `permissions[${index}].action`,
      120,
    );
    const resource = requiredText(
      rule.resource,
      `permissions[${index}].resource`,
      4096,
    );
    if (
      typeof rule.effect !== 'string' ||
      !permissionEffects.has(rule.effect as AgentPermissionEffect)
    )
      throw new Error(
        `Agent template permissions[${index}].effect must be allow, ask, or deny.`,
      );
    return {
      action,
      resource,
      effect: rule.effect as AgentPermissionEffect,
    };
  });
}

function normalizeInput(value: unknown): SaveAgentTemplateInput {
  const input = inputFields(value, inputKeys);
  const scope = validateWritableScope(input.scope);
  const id = validateId(input.id);
  const name = optionalText(input.name, 'name', 120);
  const description = optionalText(input.description, 'description', 500);
  if (
    input.instructions !== undefined &&
    typeof input.instructions !== 'string'
  )
    throw new Error('Agent template instructions must be text.');
  const instructions = (input.instructions ?? '').trim();
  if (instructions.length > 64_000)
    throw new Error(
      'Agent template instructions must contain at most 64000 characters.',
    );
  const mode = validateMode(input.mode);
  const context = validateContext(input.context);
  const {model, shorthandThinkingLevel} = validateModel(input.model);
  const thinkingLevel =
    validateThinkingLevel(input.thinkingLevel) ?? shorthandThinkingLevel;
  const hidden = optionalBoolean(input.hidden, 'hidden');
  const disabled = optionalBoolean(input.disabled, 'disabled');
  const color = validateColor(input.color);
  const steps = validateSteps(input.steps);
  const permissions = validatePermissions(input.permissions);
  const sourcePath = optionalText(input.sourcePath, 'sourcePath', 4096);
  if (sourcePath !== undefined && !isAbsolute(sourcePath))
    throw new Error('Agent template sourcePath must be absolute.');
  return {
    scope,
    id,
    instructions,
    ...(name !== undefined ? {name} : {}),
    ...(description !== undefined ? {description} : {}),
    ...(mode !== undefined ? {mode} : {}),
    ...(context !== undefined ? {context} : {}),
    ...(model !== undefined ? {model} : {}),
    ...(thinkingLevel !== undefined ? {thinkingLevel} : {}),
    ...(hidden !== undefined ? {hidden} : {}),
    ...(disabled !== undefined ? {disabled} : {}),
    ...(color !== undefined ? {color} : {}),
    ...(steps !== undefined ? {steps} : {}),
    ...(permissions !== undefined ? {permissions} : {}),
    ...(sourcePath !== undefined ? {sourcePath} : {}),
  };
}

function templateFromContent(
  content: string,
  scope: AgentTemplateScope,
  sourcePath: string,
  id: string,
): AgentTemplateDefinition {
  if (Buffer.byteLength(content, 'utf8') > maxFileBytes)
    throw new Error(`Agent template file exceeds ${maxFileBytes} bytes.`);
  validateId(id);
  let parsed: ReturnType<typeof parseFrontmatter<TemplateFrontmatter>>;
  try {
    parsed = parseFrontmatter<TemplateFrontmatter>(content);
  } catch (error) {
    throw new Error(
      `Invalid YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const unknown = Object.keys(parsed.frontmatter).filter(
    key => !frontmatterKeys.has(key),
  );
  if (unknown.length)
    throw new Error(`Unknown frontmatter field: ${unknown.join(', ')}.`);
  const name = optionalText(parsed.frontmatter.name, 'name', 120);
  const description = optionalText(
    parsed.frontmatter.description,
    'description',
    500,
  );
  const mode = validateMode(parsed.frontmatter.mode);
  const context = validateContext(parsed.frontmatter.context);
  const {model, shorthandThinkingLevel} = validateModel(
    parsed.frontmatter.model,
  );
  const thinkingLevel =
    validateThinkingLevel(parsed.frontmatter.thinkingLevel) ??
    shorthandThinkingLevel;
  const hidden = optionalBoolean(parsed.frontmatter.hidden, 'hidden');
  const disabled = optionalBoolean(parsed.frontmatter.disabled, 'disabled');
  const color = validateColor(parsed.frontmatter.color);
  const steps = validateSteps(parsed.frontmatter.steps);
  const permissions = validatePermissions(parsed.frontmatter.permissions);
  if (parsed.body.length > 64_000)
    throw new Error(
      'Agent template instructions must contain at most 64000 characters.',
    );
  return {
    id,
    key: scopedKey(scope, id),
    instructions: parsed.body,
    ...(name !== undefined ? {name} : {}),
    ...(description !== undefined ? {description} : {}),
    ...(mode !== undefined ? {mode} : {}),
    ...(context !== undefined ? {context} : {}),
    ...(model !== undefined ? {model} : {}),
    ...(thinkingLevel !== undefined ? {thinkingLevel} : {}),
    ...(hidden !== undefined ? {hidden} : {}),
    ...(disabled !== undefined ? {disabled} : {}),
    ...(color !== undefined ? {color} : {}),
    ...(steps !== undefined ? {steps} : {}),
    ...(permissions !== undefined ? {permissions} : {}),
    scope,
    sourcePath,
  };
}

function serializeTemplate(input: SaveAgentTemplateInput): string {
  const fields = [
    ...(input.name !== undefined
      ? [`name: ${JSON.stringify(input.name)}`]
      : []),
    ...(input.description !== undefined
      ? [`description: ${JSON.stringify(input.description)}`]
      : []),
    ...(input.mode !== undefined ? [`mode: ${input.mode}`] : []),
    ...(input.context !== undefined ? [`context: ${input.context}`] : []),
    ...(input.model !== undefined
      ? [`model: ${JSON.stringify(input.model)}`]
      : []),
    ...(input.thinkingLevel !== undefined
      ? [`thinkingLevel: ${input.thinkingLevel}`]
      : []),
    ...(input.hidden !== undefined ? [`hidden: ${input.hidden}`] : []),
    ...(input.disabled !== undefined ? [`disabled: ${input.disabled}`] : []),
    ...(input.color !== undefined
      ? [`color: ${JSON.stringify(input.color)}`]
      : []),
    ...(input.steps !== undefined ? [`steps: ${input.steps}`] : []),
    ...(input.permissions !== undefined
      ? input.permissions.length
        ? [
            'permissions:',
            ...input.permissions.flatMap(rule => [
              `  - action: ${JSON.stringify(rule.action)}`,
              `    resource: ${JSON.stringify(rule.resource)}`,
              `    effect: ${rule.effect}`,
            ]),
          ]
        : ['permissions: []']
      : []),
  ];
  const header = fields.length ? `${fields.join('\n')}\n` : '';
  const body = input.instructions ?? '';
  return `---\n${header}---\n${body ? `\n${body}\n` : ''}`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

interface TemplateLocations {
  agentDir: string;
  projectDirectories: string[];
  builtinDirectories: string[];
  globalDirectory: string;
  repositoryDirectories: string[];
  workspaceDirectory: string;
  workspaceConfigDirectory: string;
}

function canonicalDirectory(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function projectDirectories(cwd: string, projectDir: string): string[] {
  const current = canonicalDirectory(cwd);
  const nested = relative(projectDir, current);
  if (nested === '..' || nested.startsWith(`..${sep}`) || isAbsolute(nested))
    return [projectDir];
  const result = [projectDir];
  let directory = projectDir;
  for (const segment of nested.split(sep).filter(Boolean)) {
    directory = join(directory, segment);
    result.push(directory);
  }
  return result;
}

function templateLocations(cwd: string): TemplateLocations {
  const agentDir = resolve(getAgentDir());
  const paths = workspaceConfigPaths(cwd, agentDir);
  const ancestors = projectDirectories(cwd, paths.projectDir);
  return {
    agentDir,
    projectDirectories: ancestors,
    builtinDirectories: [builtinAgentsDirectory, builtinCommitAgentsDirectory],
    globalDirectory: join(agentDir, 'agents'),
    repositoryDirectories: ancestors
      .filter(
        (directory, index) =>
          index === 0 || existsSync(join(directory, CONFIG_DIR_NAME)),
      )
      .map(directory => join(directory, CONFIG_DIR_NAME, 'agents')),
    workspaceDirectory: join(paths.workspaceDir, 'agents'),
    workspaceConfigDirectory: paths.workspaceDir,
  };
}

function compareTemplates(
  a: Pick<AgentTemplateDefinition, 'id' | 'scope'>,
  b: Pick<AgentTemplateDefinition, 'id' | 'scope'>,
): number {
  return (
    a.id.localeCompare(b.id) ||
    scopes.indexOf(a.scope) - scopes.indexOf(b.scope)
  );
}

async function loadSource(
  scope: AgentTemplateScope,
  directory: string,
): Promise<{
  source: AgentTemplateSource;
  diagnostics: AgentTemplateDiagnostic[];
}> {
  const templates: AgentTemplateDefinition[] = [];
  const diagnostics: AgentTemplateDiagnostic[] = [];

  async function visit(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, {withFileTypes: true});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      diagnostics.push({
        scope,
        sourcePath: current,
        message: `Cannot read agent template directory: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const sourcePath = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        diagnostics.push({
          scope,
          sourcePath,
          message: 'Agent template paths must not be symbolic links.',
        });
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.md'))
          diagnostics.push({
            scope,
            sourcePath,
            message: 'Agent template must be a regular Markdown file.',
          });
        else await visit(sourcePath);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      if (!entry.isFile()) {
        diagnostics.push({
          scope,
          sourcePath,
          message: 'Agent template must be a regular Markdown file.',
        });
        continue;
      }
      const relativePath = relative(directory, sourcePath);
      const id = relativePath.slice(0, -'.md'.length).split(sep).join('/');
      try {
        templates.push(
          templateFromContent(
            await readFile(sourcePath, 'utf8'),
            scope,
            sourcePath,
            id,
          ),
        );
      } catch (error) {
        diagnostics.push({
          scope,
          sourcePath,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  await visit(directory);
  templates.sort(compareTemplates);
  return {source: {scope, directory, templates}, diagnostics};
}

async function loadBuiltinSource(): Promise<{
  source: AgentTemplateSource;
  diagnostics: AgentTemplateDiagnostic[];
}> {
  const [agents, commit] = await Promise.all([
    loadSource('builtin', builtinAgentsDirectory),
    loadSource('builtin', builtinCommitAgentsDirectory),
  ]);
  const templates = [...agents.source.templates, ...commit.source.templates];
  if (!templates.some(template => template.id === 'default'))
    templates.push(createDefaultAgentProfile());
  return {
    source: {
      scope: 'builtin',
      directory: builtinAgentsDirectory,
      templates: templates.sort(compareTemplates),
    },
    diagnostics: [...agents.diagnostics, ...commit.diagnostics],
  };
}

interface SharedPermissions {
  rules: AgentPermissionRule[];
  diagnostics: AgentTemplateDiagnostic[];
  sourcePaths: string[];
}

function sharedPermissionsError(
  diagnostics: readonly AgentTemplateDiagnostic[],
): Error | undefined {
  if (!diagnostics.length) return undefined;
  return new Error(
    `Cannot resolve agent profile because shared permissions are invalid: ${diagnostics
      .map(item => `${item.sourcePath || item.scope}: ${item.message}`)
      .join('; ')}`,
  );
}

function permissionsFromSettings(
  settings: unknown,
  scope: AgentTemplateScope,
  sourcePath: string,
): SharedPermissions {
  const value = (settings as Record<string, unknown> | undefined)?.permissions;
  if (value === undefined) return {rules: [], diagnostics: [], sourcePaths: []};
  try {
    return {
      rules: validatePermissions(value) ?? [],
      diagnostics: [],
      sourcePaths: [sourcePath],
    };
  } catch (error) {
    return {
      rules: [],
      diagnostics: [
        {
          scope,
          sourcePath,
          message: `Invalid shared agent permissions: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      sourcePaths: [sourcePath],
    };
  }
}

function settingsDiagnostics(
  manager: SettingsManager,
  settingScope: 'global' | 'project',
  templateScope: AgentTemplateScope,
): AgentTemplateDiagnostic[] {
  return manager
    .drainErrors()
    .filter(item => item.scope === settingScope)
    .map(item => ({
      scope: templateScope,
      sourcePath: item.path ?? '',
      message: `Cannot read shared agent permissions: ${item.error.message}`,
    }));
}

function loadSharedPermissions(
  locations: TemplateLocations,
): SharedPermissions {
  const layers: SharedPermissions[] = [];
  const global = SettingsManager.create(
    locations.projectDirectories.at(-1)!,
    locations.agentDir,
    {projectTrusted: false},
  );
  const globalLayer = permissionsFromSettings(
    global.getGlobalSettings(),
    'global',
    join(locations.agentDir, 'settings.json'),
  );
  globalLayer.diagnostics.push(
    ...settingsDiagnostics(global, 'global', 'global'),
  );
  layers.push(globalLayer);
  for (const directory of locations.projectDirectories) {
    const manager = SettingsManager.create(directory, locations.agentDir, {
      projectTrusted: true,
    });
    const repositoryLayer = permissionsFromSettings(
      manager.getProjectSettings(),
      'repository',
      join(directory, CONFIG_DIR_NAME, 'settings.json'),
    );
    repositoryLayer.diagnostics.push(
      ...settingsDiagnostics(manager, 'project', 'repository'),
    );
    layers.push(repositoryLayer);
  }
  const workspace = SettingsManager.create(
    locations.projectDirectories[0],
    locations.workspaceConfigDirectory,
    {projectTrusted: false},
  );
  const workspaceLayer = permissionsFromSettings(
    workspace.getGlobalSettings(),
    'workspace',
    join(locations.workspaceConfigDirectory, 'settings.json'),
  );
  workspaceLayer.diagnostics.push(
    ...settingsDiagnostics(workspace, 'global', 'workspace'),
  );
  layers.push(workspaceLayer);
  return {
    rules: layers.flatMap(layer => layer.rules),
    diagnostics: layers.flatMap(layer => layer.diagnostics),
    sourcePaths: layers.flatMap(layer => layer.sourcePaths),
  };
}

function mergeDefinitions(
  id: string,
  definitions: AgentTemplateDefinition[],
  sharedPermissions: readonly AgentPermissionRule[],
  permissionsValid = true,
): AgentTemplate {
  const selected = definitions.at(-1);
  if (!selected) throw new Error(`Cannot merge missing agent template ${id}.`);
  let name: string | undefined;
  let description: string | undefined;
  let instructions = '';
  let hasInstructions = false;
  let mode: AgentMode | undefined;
  let context: AgentContextScope | undefined;
  let model: string | undefined;
  let thinkingLevel: AgentTemplateThinkingLevel | undefined;
  let hidden: boolean | undefined;
  let disabled: boolean | undefined;
  let color: string | undefined;
  let steps: number | undefined;
  const permissions: AgentPermissionRule[] = sharedPermissions.map(rule => ({
    ...rule,
  }));
  for (const definition of definitions) {
    if (definition.name !== undefined) name = definition.name;
    if (definition.description !== undefined)
      description = definition.description;
    if (definition.instructions || !hasInstructions) {
      instructions = definition.instructions;
      hasInstructions = true;
    }
    if (definition.mode !== undefined) mode = definition.mode;
    if (definition.context !== undefined) context = definition.context;
    if (definition.model !== undefined) model = definition.model;
    if (definition.thinkingLevel !== undefined)
      thinkingLevel = definition.thinkingLevel;
    if (definition.hidden !== undefined) hidden = definition.hidden;
    if (definition.disabled !== undefined) disabled = definition.disabled;
    if (definition.color !== undefined) color = definition.color;
    if (definition.steps !== undefined) steps = definition.steps;
    if (definition.permissions) permissions.push(...definition.permissions);
  }
  return {
    id,
    key: selected.key,
    name: name ?? id,
    instructions,
    mode: mode ?? 'primary',
    context: context ?? 'workspace',
    hidden: hidden ?? false,
    disabled: disabled ?? false,
    permissions,
    ...(permissionsValid ? {permissionsVersion: 1 as const} : {}),
    ...(description !== undefined ? {description} : {}),
    ...(model !== undefined ? {model} : {}),
    ...(thinkingLevel !== undefined ? {thinkingLevel} : {}),
    ...(color !== undefined ? {color} : {}),
    ...(steps !== undefined ? {steps} : {}),
    scope: selected.scope,
    sourcePath: selected.sourcePath,
  };
}

function configuredDefaultAgent(cwd: string): string | undefined {
  const settings = createWorkspaceConfiguration(
    cwd,
    resolve(getAgentDir()),
  ).settingsManager.getSettings() as Record<string, unknown>;
  const value = settings.default_agent;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function primaryVisible(template: AgentTemplate): boolean {
  return (
    !template.hidden &&
    !template.disabled &&
    (template.mode === 'primary' || template.mode === 'all')
  );
}

interface LoadedTemplateLayers {
  sources: AgentTemplateSource[];
  diagnostics: AgentTemplateDiagnostic[];
  sharedPermissions: AgentPermissionRule[];
  sharedPermissionSourcePaths: string[];
  sharedPermissionsError?: Error;
}

async function loadTemplateLayers(cwd: string): Promise<LoadedTemplateLayers> {
  const locations = templateLocations(cwd);
  const shared = loadSharedPermissions(locations);
  const [builtin, global, repositories, workspace] = await Promise.all([
    loadBuiltinSource(),
    loadSource('global', locations.globalDirectory),
    Promise.all(
      locations.repositoryDirectories.map(directory =>
        loadSource('repository', directory),
      ),
    ),
    loadSource('workspace', locations.workspaceDirectory),
  ]);
  const loaded = [builtin, global, ...repositories, workspace];
  const permissionsError = sharedPermissionsError(shared.diagnostics);
  return {
    sources: loaded.map(item => item.source),
    diagnostics: [
      ...loaded.flatMap(item => item.diagnostics),
      ...shared.diagnostics,
    ],
    sharedPermissions: shared.rules,
    sharedPermissionSourcePaths: shared.sourcePaths,
    ...(permissionsError ? {sharedPermissionsError: permissionsError} : {}),
  };
}

function definitionsFor(
  sources: AgentTemplateSource[],
  id: string,
  throughScope?: AgentTemplateScope,
): AgentTemplateDefinition[] {
  const maximum =
    throughScope === undefined
      ? scopes.length - 1
      : scopes.indexOf(throughScope);
  return sources
    .filter(source => scopes.indexOf(source.scope) <= maximum)
    .flatMap(source => source.templates.filter(template => template.id === id));
}

function resolveFromLayers(
  loaded: LoadedTemplateLayers,
  value: string,
): AgentTemplate | undefined {
  if (loaded.sharedPermissionsError) throw loaded.sharedPermissionsError;
  const separator = value.indexOf(':');
  if (separator !== -1) {
    const scope = validateScope(value.slice(0, separator));
    const id = validateId(value.slice(separator + 1));
    if (
      !loaded.sources.some(
        source =>
          source.scope === scope &&
          source.templates.some(template => template.id === id),
      )
    )
      return undefined;
    const definitions = definitionsFor(loaded.sources, id, scope);
    return mergeDefinitions(id, definitions, loaded.sharedPermissions);
  }
  const id = validateId(value);
  const definitions = definitionsFor(loaded.sources, id);
  return definitions.length
    ? mergeDefinitions(id, definitions, loaded.sharedPermissions)
    : undefined;
}

export async function listAgentTemplates(
  cwd: string,
): Promise<AgentTemplateList> {
  const loaded = await loadTemplateLayers(cwd);
  const byId = new Map<string, AgentTemplateDefinition[]>();
  for (const source of loaded.sources)
    for (const definition of source.templates) {
      const current = byId.get(definition.id) ?? [];
      current.push(definition);
      byId.set(definition.id, current);
    }
  const effective = [...byId.entries()]
    .map(([id, definitions]) =>
      mergeDefinitions(
        id,
        definitions,
        loaded.sharedPermissions,
        !loaded.sharedPermissionsError,
      ),
    )
    .sort(compareTemplates);
  const templates = effective.filter(template => !template.disabled);
  const configured = configuredDefaultAgent(cwd);
  const defaultAgentId =
    configured &&
    effective.some(
      template => template.id === configured && primaryVisible(template),
    )
      ? configured
      : effective.some(
            template => template.id === 'default' && primaryVisible(template),
          )
        ? 'default'
        : 'builtin:default';
  return {
    templates,
    allTemplates: loaded.sources.flatMap(source => source.templates),
    sources: loaded.sources,
    diagnostics: loaded.diagnostics,
    defaultAgentId,
  };
}

export async function resolveDefaultAgentTemplate(
  cwd: string,
  role: 'primary' | 'subagent' = 'primary',
): Promise<AgentTemplate> {
  const loaded = await loadTemplateLayers(cwd);
  const configured =
    role === 'primary' ? configuredDefaultAgent(cwd) : undefined;
  const configuredCandidate = configured
    ? resolveFromLayers(loaded, configured)
    : undefined;
  const selector =
    configuredCandidate && primaryVisible(configuredCandidate)
      ? configured!
      : 'default';
  const candidate = resolveFromLayers(loaded, selector);
  return candidate &&
    !candidate.hidden &&
    !candidate.disabled &&
    candidate.mode !== (role === 'primary' ? 'subagent' : 'primary')
    ? structuredClone(candidate)
    : mergeDefinitions(
        'default',
        [createDefaultAgentProfile()],
        loaded.sharedPermissions,
      );
}

export async function resolveAgentTemplate(
  cwd: string,
  value: unknown,
): Promise<AgentTemplate | undefined> {
  if (typeof value !== 'string')
    throw new Error('Agent template id or key must be text.');
  return resolveFromLayers(await loadTemplateLayers(cwd), value);
}

/** Resolve and pin the exact files and value used by an agent_templates get. */
export async function prepareAgentTemplateGet(
  cwd: string,
  value: unknown,
): Promise<PreparedAgentTemplateGet> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Agent template get input must be an object.');
  const input = value as Record<PropertyKey, unknown>;
  if (input.action !== 'get')
    throw new Error('Agent template get preparation requires action=get.');
  if (typeof input.id !== 'string') throw new Error('Choose a template ID.');
  const requestedId = input.id;
  const scope =
    input.scope === undefined ? undefined : validateScope(input.scope);
  const sourcePath =
    input.sourcePath === undefined
      ? undefined
      : optionalText(input.sourcePath, 'sourcePath', 4096);
  if (sourcePath !== undefined && !isAbsolute(sourcePath))
    throw new Error('Agent template sourcePath must be absolute.');
  if (sourcePath !== undefined && scope === undefined)
    throw new Error(
      'Agent template sourcePath requires an exact template scope.',
    );
  const signature = JSON.stringify([
    canonicalDirectory(cwd),
    requestedId,
    scope ?? null,
    sourcePath ?? null,
  ]);
  const cached = input[preparedTemplateGet] as
    CachedAgentTemplateGet | undefined;
  if (cached) {
    if (cached.signature !== signature)
      throw new Error(
        'Agent template selector changed after permission approval.',
      );
    return cached;
  }

  const loaded = await loadTemplateLayers(cwd);
  let result: AgentTemplate | AgentTemplateDefinition | undefined;
  let sourcePaths: string[];
  if (scope !== undefined) {
    const id = validateId(requestedId);
    const normalizedSource = sourcePath && resolve(sourcePath);
    result = loaded.sources
      .flatMap(source => source.templates)
      .findLast(
        template =>
          template.id === id &&
          template.scope === scope &&
          (normalizedSource === undefined ||
            resolve(template.sourcePath) === normalizedSource),
      );
    sourcePaths = result ? [result.sourcePath] : [];
  } else {
    result = resolveFromLayers(loaded, requestedId);
    const separator = requestedId.indexOf(':');
    const throughScope =
      separator === -1
        ? undefined
        : validateScope(requestedId.slice(0, separator));
    const id = validateId(
      separator === -1 ? requestedId : requestedId.slice(separator + 1),
    );
    const definitions = definitionsFor(loaded.sources, id, throughScope);
    sourcePaths = [
      ...loaded.sharedPermissionSourcePaths,
      ...definitions.map(definition => definition.sourcePath),
    ];
  }
  if (!result) throw new Error(`Unknown agent template: ${requestedId}`);
  const prepared: CachedAgentTemplateGet = Object.freeze({
    signature,
    sourcePaths: Object.freeze(
      [...new Set(sourcePaths)].filter(source => source.length > 0),
    ),
    value: structuredClone(result),
  });
  Object.defineProperty(input, preparedTemplateGet, {
    value: prepared,
    enumerable: false,
  });
  return prepared;
}

/** Upgrade a persisted profile snapshot by composing current shared permissions once. */
export async function ensureAgentProfilePermissions(
  cwd: string,
  snapshot: AgentTemplate,
): Promise<AgentTemplate> {
  const profile = structuredClone(snapshot) as AgentTemplate & {
    request?: unknown;
  };
  delete profile.request;
  if (profile.permissionsVersion === 1) return profile;
  const loaded = await loadTemplateLayers(cwd);
  if (loaded.sharedPermissionsError) throw loaded.sharedPermissionsError;
  return {
    ...profile,
    permissions: [
      ...structuredClone(loaded.sharedPermissions),
      ...structuredClone(profile.permissions ?? []),
    ],
    permissionsVersion: 1,
  };
}

async function assertReplaceable(
  path: string,
  scope: AgentTemplateScope,
  id: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!metadata.isFile())
    throw new Error(`Refusing to replace non-file agent template at ${path}.`);
  try {
    templateFromContent(await readFile(path, 'utf8'), scope, path, id);
  } catch (error) {
    throw new Error(
      `Refusing to replace malformed agent template at ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function templateParentDirectory(
  root: string,
  id: string,
  create: boolean,
): Promise<string | undefined> {
  const configurationDirectory = dirname(root);
  try {
    const metadata = await lstat(configurationDirectory);
    if (!metadata.isDirectory())
      throw new Error(
        `Agent configuration path is not a directory: ${configurationDirectory}.`,
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!create) return undefined;
    await mkdir(configurationDirectory, {recursive: true, mode: 0o700});
    const metadata = await lstat(configurationDirectory);
    if (!metadata.isDirectory())
      throw new Error(
        `Agent configuration path is not a directory: ${configurationDirectory}.`,
      );
  }
  const segments = id.split('/').slice(0, -1);
  let current = root;
  const paths = [root];
  for (const segment of segments) {
    current = join(current, segment);
    paths.push(current);
  }
  for (const path of paths) {
    try {
      const metadata = await lstat(path);
      if (!metadata.isDirectory())
        throw new Error(
          `Agent template directory path is not a directory: ${path}.`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return undefined;
      try {
        await mkdir(path, {
          mode: 0o700,
          ...(path === root ? {recursive: true} : {}),
        });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST')
          throw mkdirError;
        const metadata = await lstat(path);
        if (!metadata.isDirectory())
          throw new Error(
            `Agent template directory path is not a directory: ${path}.`,
          );
      }
    }
  }
  return current;
}

function writableDirectories(
  locations: TemplateLocations,
  scope: WritableAgentTemplateScope,
): string[] {
  if (scope === 'global') return [locations.globalDirectory];
  if (scope === 'workspace') return [locations.workspaceDirectory];
  return locations.repositoryDirectories;
}

function writableDestination(
  cwd: string,
  scope: WritableAgentTemplateScope,
  id: string,
  sourcePath?: string,
): {directory: string; path: string} {
  const directories = writableDirectories(templateLocations(cwd), scope);
  const destinations = directories.map(directory => ({
    directory,
    path: join(directory, ...id.split('/')) + '.md',
  }));
  if (sourcePath === undefined) return destinations[0];
  const normalized = resolve(sourcePath);
  const selected = destinations.find(item => resolve(item.path) === normalized);
  if (!selected)
    throw new Error(
      'Agent template sourcePath must match the selected scope, ID, and a discovered configuration directory.',
    );
  return selected;
}

export async function saveAgentTemplate(
  cwd: string,
  value: unknown,
): Promise<AgentTemplateDefinition> {
  const input = normalizeInput(value);
  const {directory, path} = writableDestination(
    cwd,
    input.scope,
    input.id,
    input.sourcePath,
  );
  const content = serializeTemplate(input);
  if (Buffer.byteLength(content, 'utf8') > maxFileBytes)
    throw new Error(`Agent template file exceeds ${maxFileBytes} bytes.`);
  await withFileMutationQueue(path, async () => {
    const destinationDirectory = (await templateParentDirectory(
      directory,
      input.id,
      true,
    ))!;
    await assertReplaceable(path, input.scope, input.id);
    const filename = input.id.split('/').at(-1)!;
    const temporary = join(
      destinationDirectory,
      `.${filename}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporary, content, {
        flag: 'wx',
        mode: input.scope === 'repository' ? 0o644 : 0o600,
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, {force: true});
    }
  });
  return templateFromContent(content, input.scope, path, input.id);
}

export async function deleteAgentTemplate(
  cwd: string,
  value: unknown,
): Promise<void> {
  const input = inputFields(value, new Set(['scope', 'id', 'sourcePath']));
  const scope = validateWritableScope(input.scope);
  const id = validateId(input.id);
  const sourcePath = optionalText(input.sourcePath, 'sourcePath', 4096);
  if (sourcePath !== undefined && !isAbsolute(sourcePath))
    throw new Error('Agent template sourcePath must be absolute.');
  const {directory, path} = writableDestination(cwd, scope, id, sourcePath);
  await withFileMutationQueue(path, async () => {
    if (!(await templateParentDirectory(directory, id, false))) return;
    if (!(await exists(path))) return;
    await assertReplaceable(path, scope, id);
    await unlink(path);
    let current = dirname(path);
    while (current !== directory) {
      try {
        await rmdir(current);
      } catch {
        break;
      }
      current = dirname(current);
    }
  });
}
