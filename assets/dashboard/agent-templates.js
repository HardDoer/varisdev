/* global document */

const THINKING_LEVELS = new Set([
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);
const AGENT_MODES = new Set(['primary', 'subagent', 'all']);
const AGENT_CONTEXTS = new Set(['workspace', 'task']);
const PERMISSION_EFFECTS = new Set(['allow', 'ask', 'deny']);

export function initAgentTemplates({api, selected, launchCwd, opened}) {
  const $ = id => document.getElementById(id);
  const newButton = $('open-new-agent');
  const menuNewButton = $('menu-new-agent');
  const templatesButton = $('open-agent-templates');
  const newDialog = $('new-agent-dialog');
  const templatesDialog = $('agent-templates-dialog');
  if (!newButton || !templatesButton || !newDialog || !templatesDialog) {
    return {render() {}, dispose() {}};
  }

  const listeners = [];
  let disposed = false;
  const createState = {
    cwd: '',
    templates: [],
    busy: false,
    loading: false,
    choosing: false,
    failure: '',
    diagnostics: '',
    request: 0,
    createdId: undefined,
    opened: false,
    prompted: false,
    submission: undefined,
    defaultAgentId: undefined,
    recentFolders: [],
    recentLoading: false,
    recentFailure: '',
    recentRequest: 0,
  };
  const templateState = {
    cwd: '',
    data: undefined,
    toolSettings: undefined,
    modelFailure: '',
    busy: false,
    loading: false,
    choosing: false,
    failure: '',
    message: '',
    request: 0,
    selectedKey: undefined,
    draft: undefined,
    deleteConfirmation: false,
    operation: '',
  };

  function listen(element, event, callback) {
    element.addEventListener(event, callback);
    listeners.push(() => element.removeEventListener(event, callback));
  }
  function errorText(error) {
    return error?.message || String(error);
  }
  function currentCwd() {
    return selected?.()?.session?.cwd || launchCwd?.() || '';
  }
  function hideMenu() {
    const menu = $('app-menu-panel');
    if (menu?.matches(':popover-open')) menu.hidePopover();
  }
  function scopeName(scope) {
    if (scope === 'workspace') return 'Workspace (this machine)';
    if (scope === 'repository') return 'Repository';
    if (scope === 'builtin') return 'Built-in';
    return 'Global';
  }
  function scopeReference(scope) {
    return scope === 'workspace' ? 'workspace' : scope;
  }
  function templateKey(template) {
    return `${template.scope}:${template.id}`;
  }
  function templateIdentity(template) {
    return `${template.scope}:${template.sourcePath}`;
  }
  function templateDirectory(data, scope) {
    return data?.sources?.find(item => item.scope === scope)?.directory || '';
  }
  function pathIn(directory, name) {
    if (!directory || !name) return directory || '';
    const separator =
      directory.includes('\\') && !directory.includes('/') ? '\\' : '/';
    return `${directory.replace(/[\\/]$/, '')}${separator}${name}.md`;
  }
  function setError(element, message) {
    element.textContent = message;
    element.hidden = !message;
  }
  function closeDialog(dialog) {
    if (dialog.open) dialog.close();
  }

  function renderAvailability() {
    const createUnavailable = !(
      api?.createSession &&
      api?.listAgentTemplates &&
      api?.promptSession
    );
    newButton.disabled = createUnavailable;
    if (menuNewButton) menuNewButton.disabled = createUnavailable;
    templatesButton.disabled = !(
      api?.listAgentTemplates &&
      api?.saveAgentTemplate &&
      api?.deleteAgentTemplate
    );
  }

  function createWorking() {
    return createState.busy || createState.loading || createState.choosing;
  }
  function renderCreate() {
    const working = createWorking();
    const created = Boolean(createState.createdId);
    $('new-agent-folder').textContent = createState.cwd || 'Choose a folder';
    $('new-agent-folder').title = createState.cwd;
    $('new-agent-workspace').classList.toggle(
      'has-selection',
      !!createState.cwd,
    );
    $('new-agent-workspace-label').textContent = createState.cwd
      ? 'Selected workspace'
      : 'Workspace';
    const recent = $('new-agent-recent');
    recent.value = createState.recentFolders.includes(createState.cwd)
      ? createState.cwd
      : '';
    recent.title = recent.value;
    recent.classList.toggle('has-selection', !!recent.value);
    $('new-agent-template').classList.toggle(
      'has-selection',
      !!$('new-agent-template').value,
    );
    $('new-agent-choose-folder').disabled =
      working || created || !api?.chooseFolder;
    $('new-agent-recent').disabled =
      createState.busy ||
      createState.choosing ||
      created ||
      createState.recentLoading ||
      !createState.recentFolders.length;
    $('new-agent-recent-workspaces').hidden = !api?.recentProjects;
    $('new-agent-recent-status').textContent = createState.recentLoading
      ? 'Loading recent workspaces…'
      : !createState.recentFolders.length && !createState.recentFailure
        ? 'No recent workspaces yet.'
        : '';
    setError($('new-agent-recent-error'), createState.recentFailure);
    $('new-agent-template').disabled = working || created;
    $('new-agent-name').disabled = createState.busy || created;
    $('new-agent-name').placeholder =
      createState.cwd.split(/[\\/]/).filter(Boolean).at(-1) || createState.cwd;
    $('new-agent-task').disabled = createState.busy || created;
    $('new-agent-close').disabled = createState.busy;
    $('new-agent-cancel').disabled = createState.busy;
    $('new-agent-create').disabled =
      working ||
      !createState.cwd ||
      !$('new-agent-template').value ||
      !api?.createSession;
    $('new-agent-create').textContent = created
      ? 'Retry'
      : 'Start conversation';
    let status = '';
    if (createState.choosing) status = 'Choosing folder…';
    else if (createState.loading) status = 'Loading agent configurations…';
    else if (createState.busy) {
      status = !createState.createdId
        ? 'Creating conversation…'
        : !createState.opened
          ? 'Opening conversation…'
          : 'Sending initial message…';
    } else if (created && !createState.opened)
      status = 'Conversation created. Opening needs to be retried.';
    else if (created && !createState.prompted)
      status = 'Conversation created. The initial message needs to be retried.';
    $('new-agent-status').textContent = status;
    setError(
      $('new-agent-error'),
      [createState.failure, createState.diagnostics].filter(Boolean).join('\n'),
    );
  }
  function resetCreate() {
    createState.request++;
    createState.recentRequest++;
    createState.recentFolders = [];
    createState.recentLoading = false;
    createState.recentFailure = '';
    $('new-agent-recent').replaceChildren();
    createState.cwd = '';
    createState.templates = [];
    createState.busy = false;
    createState.loading = false;
    createState.choosing = false;
    createState.failure = '';
    createState.diagnostics = '';
    createState.createdId = undefined;
    createState.opened = false;
    createState.prompted = false;
    createState.submission = undefined;
    createState.defaultAgentId = undefined;
    $('new-agent-form').reset();
    $('new-agent-template').replaceChildren();
    renderCreate();
  }
  function templateName(template) {
    return template.name || template.id;
  }
  function createTemplateSelector(template) {
    return template.key && template.id.includes(':')
      ? template.key
      : template.id;
  }
  function populateCreateTemplates(templates) {
    const selectedTemplate = $('new-agent-template').value;
    const options = templates.map(template => {
      const option = document.createElement('option');
      option.value = createTemplateSelector(template);
      option.textContent = `${templateName(template)} · ${scopeName(template.scope)}`;
      if (template.description) option.title = template.description;
      return option;
    });
    $('new-agent-template').replaceChildren(...options);
    const preservingSelection = templates.some(
      template => createTemplateSelector(template) === selectedTemplate,
    );
    const fallback =
      templates.find(
        template =>
          template.id === createState.defaultAgentId ||
          createTemplateSelector(template) === createState.defaultAgentId,
      ) ||
      templates.find(template => template.id === 'default') ||
      templates[0];
    const selectedId = preservingSelection
      ? selectedTemplate
      : fallback
        ? createTemplateSelector(fallback)
        : '';
    $('new-agent-template').value = selectedId;
  }
  async function loadCreateTemplates() {
    if (!createState.cwd || disposed) {
      populateCreateTemplates([]);
      renderCreate();
      return;
    }
    const request = ++createState.request;
    createState.templates = [];
    createState.defaultAgentId = undefined;
    populateCreateTemplates([]);
    createState.loading = true;
    createState.failure = '';
    createState.diagnostics = '';
    renderCreate();
    try {
      const result = await api.listAgentTemplates(createState.cwd);
      if (disposed || request !== createState.request) return;
      createState.templates = (result.templates || []).filter(
        template =>
          !template.hidden &&
          !template.disabled &&
          ['primary', 'all'].includes(template.mode || 'primary'),
      );
      createState.defaultAgentId = result.defaultAgentId;
      const scopedDefault = result.defaultAgent;
      if (
        result.defaultAgentId?.includes(':') &&
        scopedDefault &&
        !scopedDefault.hidden &&
        !scopedDefault.disabled &&
        ['primary', 'all'].includes(scopedDefault.mode || 'primary') &&
        !createState.templates.some(
          template => template.id === result.defaultAgentId,
        )
      )
        createState.templates.unshift({
          ...scopedDefault,
          id: result.defaultAgentId,
        });
      if (
        result.defaultAgentId === 'builtin:default' &&
        !createState.templates.some(
          template => template.id === result.defaultAgentId,
        )
      )
        createState.templates.unshift({
          id: 'builtin:default',
          name: 'Default',
          mode: 'all',
          scope: 'builtin',
        });
      createState.diagnostics = (result.diagnostics || [])
        .map(
          item =>
            `${scopeName(item.scope)} · ${item.sourcePath}: ${item.message}`,
        )
        .join('\n');
      populateCreateTemplates(createState.templates);
    } catch (error) {
      if (!disposed && request === createState.request)
        createState.failure = errorText(error);
    } finally {
      if (!disposed && request === createState.request) {
        createState.loading = false;
        renderCreate();
      }
    }
  }
  async function openCreate() {
    if (disposed || newButton.disabled || newDialog.open) return;
    hideMenu();
    resetCreate();
    createState.cwd = currentCwd();
    renderCreate();
    newDialog.showModal();
    $('new-agent-name').focus();
    await Promise.all([loadCreateTemplates(), loadRecentWorkspaces()]);
  }
  async function loadRecentWorkspaces() {
    if (!api?.recentProjects || disposed) return;
    const request = ++createState.recentRequest;
    createState.recentLoading = true;
    createState.recentFailure = '';
    renderCreate();
    try {
      const folders = await api.recentProjects();
      if (disposed || request !== createState.recentRequest) return;
      createState.recentFolders = folders;
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Choose a recent workspace…';
      placeholder.disabled = true;
      $('new-agent-recent').replaceChildren(
        placeholder,
        ...folders.map(cwd => {
          const option = document.createElement('option');
          option.value = cwd;
          const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) || cwd;
          option.textContent = `${name} · ${cwd}`;
          option.title = cwd;
          return option;
        }),
      );
    } catch (error) {
      if (!disposed && request === createState.recentRequest)
        createState.recentFailure = `Could not load recent workspaces: ${errorText(error)}`;
    } finally {
      if (!disposed && request === createState.recentRequest) {
        createState.recentLoading = false;
        renderCreate();
      }
    }
  }
  async function selectCreateWorkspace(cwd) {
    if (
      disposed ||
      !newDialog.open ||
      createState.busy ||
      createState.choosing ||
      createState.createdId ||
      !cwd
    )
      return;
    createState.cwd = cwd;
    await loadCreateTemplates();
  }
  async function chooseCreateFolder() {
    if (createWorking() || createState.createdId || !api?.chooseFolder) return;
    const request = ++createState.request;
    createState.choosing = true;
    createState.failure = '';
    renderCreate();
    let cwd;
    try {
      cwd = await api.chooseFolder();
    } catch (error) {
      if (!disposed && request === createState.request)
        createState.failure = errorText(error);
    } finally {
      if (!disposed && request === createState.request) {
        createState.choosing = false;
        renderCreate();
      }
    }
    if (!disposed && request === createState.request)
      await selectCreateWorkspace(cwd);
  }
  async function submitCreate(event) {
    event.preventDefault();
    if (
      createWorking() ||
      !createState.cwd ||
      !$('new-agent-template').value ||
      disposed
    )
      return;
    createState.busy = true;
    createState.failure = '';
    renderCreate();
    try {
      if (!createState.createdId) {
        const submission = {
          cwd: createState.cwd,
          name: $('new-agent-name').value.trim(),
          templateId: $('new-agent-template').value || undefined,
          task: $('new-agent-task').value.trim(),
        };
        const {cwd, name, templateId} = submission;
        const result = await api.createSession({
          cwd,
          templateId,
          ...(name ? {name} : {}),
        });
        if (!result.id)
          throw new Error('The created conversation did not return an ID.');
        createState.createdId = result.id;
        createState.submission = submission;
        renderCreate();
      }
      if (!createState.opened) {
        await opened(createState.createdId);
        createState.opened = true;
        renderCreate();
      }
      if (!createState.prompted && createState.submission.task) {
        await api.promptSession(createState.createdId, {
          prompt: createState.submission.task,
        });
      }
      createState.prompted = true;
      closeDialog(newDialog);
    } catch (error) {
      if (!disposed) createState.failure = errorText(error);
    } finally {
      createState.busy = false;
      if (!disposed && newDialog.open) renderCreate();
    }
  }

  function allTemplates() {
    return templateState.data?.allTemplates || [];
  }
  function selectedTemplate() {
    return allTemplates().find(
      template => templateIdentity(template) === templateState.selectedKey,
    );
  }
  function booleanValue(value) {
    return typeof value === 'boolean' ? String(value) : '';
  }
  function blankDraft() {
    return {
      scope: 'workspace',
      id: '',
      name: '',
      description: '',
      mode: 'primary',
      context: '',
      model: '',
      thinkingLevel: '',
      hidden: '',
      disabled: '',
      color: '',
      steps: '',
      instructions: '',
      permissions: '',
      sourcePath: '',
    };
  }
  function draftFrom(template) {
    return {
      scope: template.scope,
      id: template.id,
      name: template.name || '',
      description: template.description || '',
      mode: template.mode || '',
      context: template.context || '',
      model: template.model || '',
      thinkingLevel: template.thinkingLevel || '',
      hidden: booleanValue(template.hidden),
      disabled: booleanValue(template.disabled),
      color: template.color || '',
      steps: template.steps === undefined ? '' : String(template.steps),
      instructions: template.instructions || '',
      permissions: template.permissions
        ? JSON.stringify(template.permissions, null, 2)
        : '',
      sourcePath: template.sourcePath || '',
    };
  }
  function editableDraft(template) {
    const draft = draftFrom(template);
    return template.scope === 'builtin'
      ? {...draft, scope: 'workspace', sourcePath: ''}
      : draft;
  }
  function renderModelOptions() {
    const settings = templateState.toolSettings;
    const models = new Map(
      (settings?.models || []).map(model => [
        `${model.provider}/${model.id}`,
        model,
      ]),
    );
    const saved = templateState.draft?.model;
    const values = new Set(models.keys());
    if (saved) values.add(saved);
    const inherit = document.createElement('option');
    inherit.value = '';
    inherit.textContent = settings?.settings.agents.allowedModels?.length
      ? 'Use tool model settings'
      : 'Inherit';
    $('agent-template-model').replaceChildren(
      inherit,
      ...[...values].sort().map(value => {
        const model = models.get(value);
        const option = document.createElement('option');
        const reason = settings && !model ? ' (unavailable)' : '';
        option.value = value;
        option.textContent =
          (model ? `${model.name} (${value})` : value) + reason;
        option.disabled = !model;
        return option;
      }),
    );
  }
  function renderTemplateList() {
    const templates = allTemplates();
    const scopes = ['workspace', 'repository', 'global', 'builtin'];
    const scopedTemplates = scopes.map(scope => [
      scope,
      templates
        .map((template, index) => ({template, index}))
        .filter(entry => entry.template.scope === scope)
        .sort(
          (a, b) =>
            a.template.id.localeCompare(b.template.id) || a.index - b.index,
        )
        .map(entry => entry.template),
    ]);
    const picker = $('agent-template-picker');
    if (picker) {
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = templateState.draft
        ? 'New agent'
        : 'Select an agent';
      placeholder.disabled = true;
      picker.replaceChildren(
        placeholder,
        ...scopedTemplates.flatMap(([scope, scoped]) =>
          scoped.map(template => {
            const option = document.createElement('option');
            option.value = templateIdentity(template);
            const duplicate = templates.some(
              item =>
                item !== template &&
                item.scope === template.scope &&
                item.id === template.id,
            );
            option.textContent = [
              templateName(template),
              scopeName(scope),
              ...(duplicate ? [template.sourcePath] : []),
            ].join(' · ');
            return option;
          }),
        ),
      );
      picker.value = templateState.selectedKey || '';
      picker.disabled =
        templateState.busy || templateState.loading || templateState.choosing;
    }
    const nodes = [];
    for (const [scope, scoped] of scopedTemplates) {
      if (!scoped.length) continue;
      const heading = document.createElement('h4');
      heading.textContent = scopeName(scope);
      nodes.push(heading);
      for (const template of scoped) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'agent-template-list-item';
        button.dataset.templateKey = templateKey(template);
        button.dataset.templateIdentity = templateIdentity(template);
        const active = templateIdentity(template) === templateState.selectedKey;
        button.classList.toggle('selected', active);
        button.setAttribute('aria-pressed', String(active));
        button.disabled =
          templateState.busy || templateState.loading || templateState.choosing;
        const nameRow = document.createElement('span');
        nameRow.className = 'agent-template-list-name';
        if (/^#[0-9a-f]{6}$/i.test(template.color || '')) {
          const color = document.createElement('i');
          color.className = 'agent-template-list-color';
          color.style.backgroundColor = template.color;
          color.setAttribute('aria-hidden', 'true');
          nameRow.append(color);
        }
        const name = document.createElement('strong');
        name.textContent = templateName(template);
        nameRow.append(name);
        const id = document.createElement('span');
        id.className = 'mono';
        id.textContent = template.id;
        button.append(nameRow, id);
        if (template.description) {
          const description = document.createElement('span');
          description.textContent = template.description;
          button.append(description);
        }
        if (
          templates.some(
            item =>
              item !== template &&
              item.scope === template.scope &&
              item.id === template.id,
          )
        ) {
          const source = document.createElement('small');
          source.className = 'mono';
          source.textContent = template.sourcePath;
          button.append(source);
        }
        const profile = [
          template.mode,
          template.context === 'task'
            ? 'Task only'
            : template.context === 'workspace'
              ? 'Workspace context'
              : '',
          template.hidden ? 'Hidden' : '',
          template.disabled ? 'Disabled' : '',
        ].filter(Boolean);
        if (profile.length) {
          const status = document.createElement('small');
          status.textContent = profile.join(' · ');
          button.append(status);
        }
        const laterInScope = templates
          .slice(templates.indexOf(template) + 1)
          .some(
            item => item.scope === template.scope && item.id === template.id,
          );
        const higherScope = laterInScope
          ? scope
          : scopes
              .slice(0, scopes.indexOf(scope))
              .find(candidate =>
                templates.some(
                  item => item.scope === candidate && item.id === template.id,
                ),
              );
        if (higherScope) {
          const override = document.createElement('small');
          override.textContent = `Customized in ${scopeReference(higherScope)}`;
          button.append(override);
        }
        button.addEventListener('click', () => selectTemplate(template));
        nodes.push(button);
      }
    }
    $('agent-template-list').replaceChildren(...nodes);
    $('agent-template-list-empty').hidden = templates.length > 0;
  }
  function draftSourcePath() {
    const draft = templateState.draft;
    if (!draft) return '';
    const original = selectedTemplate();
    if (original && original.scope === draft.scope && original.id === draft.id)
      return original.sourcePath || draft.sourcePath;
    return pathIn(templateDirectory(templateState.data, draft.scope), draft.id);
  }
  function renderDraft() {
    const draft = templateState.draft;
    const form = $('agent-template-form');
    form.hidden = !draft;
    $('agent-template-editor-empty').hidden = Boolean(draft);
    if (!draft) return;
    $('agent-template-scope').value = draft.scope;
    $('agent-template-id').value = draft.id;
    $('agent-template-name').value = draft.name;
    $('agent-template-description').value = draft.description;
    $('agent-template-mode').value = AGENT_MODES.has(draft.mode)
      ? draft.mode
      : '';
    $('agent-template-context').value = AGENT_CONTEXTS.has(draft.context)
      ? draft.context
      : '';
    $('agent-template-context-note').hidden = draft.context !== 'task';
    $('agent-template-model').value = draft.model;
    $('agent-template-thinking').value = THINKING_LEVELS.has(
      draft.thinkingLevel,
    )
      ? draft.thinkingLevel
      : '';
    $('agent-template-hidden').value = draft.hidden;
    $('agent-template-disabled').value = draft.disabled;
    $('agent-template-color').value = draft.color;
    $('agent-template-steps').value = draft.steps;
    $('agent-template-instructions').value = draft.instructions;
    $('agent-template-permissions').value = draft.permissions;
    const color = $('agent-template-color-indicator');
    const validColor = /^#[0-9a-f]{6}$/i.test(draft.color);
    color.style.backgroundColor = validColor ? draft.color : '';
    color.classList.toggle('empty', !validColor);
    $('agent-template-source').textContent =
      draftSourcePath() || 'Available after choosing a folder';
    const selected = selectedTemplate();
    const existing = Boolean(selected && selected.scope !== 'builtin');
    const working = templateState.busy || templateState.loading;
    $('agent-template-scope').disabled = working || existing;
    $('agent-template-id').disabled = working || existing;
    for (const id of [
      'agent-template-name',
      'agent-template-description',
      'agent-template-mode',
      'agent-template-context',
      'agent-template-model',
      'agent-template-thinking',
      'agent-template-hidden',
      'agent-template-disabled',
      'agent-template-color',
      'agent-template-steps',
      'agent-template-instructions',
      'agent-template-permissions',
    ])
      $(id).disabled = working;
    $('agent-template-model').disabled = working || !templateState.toolSettings;
    $('agent-template-save').disabled = working || !templateState.cwd;
    $('agent-template-delete').hidden =
      !existing || templateState.deleteConfirmation;
    $('agent-template-delete').disabled = working;
    $('agent-template-delete-confirmation').hidden =
      !existing || !templateState.deleteConfirmation;
    $('agent-template-delete-cancel').disabled = working;
    $('agent-template-delete-confirm').disabled = working;
  }
  function renderDiagnostics() {
    const diagnostics = templateState.data?.diagnostics || [];
    const root = $('agent-templates-diagnostics');
    root.hidden = diagnostics.length === 0;
    root.replaceChildren(
      ...diagnostics.map(diagnostic => {
        const item = document.createElement('p');
        const source = document.createElement('strong');
        source.textContent = `${scopeName(diagnostic.scope)} · ${diagnostic.sourcePath}`;
        const message = document.createElement('span');
        message.textContent = diagnostic.message;
        item.append(source, message);
        return item;
      }),
    );
  }
  function renderTemplates() {
    const working =
      templateState.busy || templateState.loading || templateState.choosing;
    $('agent-templates-folder').textContent =
      templateState.cwd || 'Choose a folder';
    $('agent-templates-choose-folder').disabled = working || !api?.chooseFolder;
    $('agent-templates-close').disabled = templateState.busy;
    $('agent-template-new').disabled = working || !templateState.cwd;
    let status = templateState.message;
    if (templateState.choosing) status = 'Choosing folder…';
    else if (templateState.loading) status = 'Loading agent configurations…';
    else if (templateState.busy)
      status = templateState.operation === 'delete' ? 'Deleting…' : 'Saving…';
    else if (!templateState.cwd)
      status = 'Choose a folder to load agent configurations.';
    $('agent-templates-status').textContent = status;
    setError(
      $('agent-templates-error'),
      [templateState.failure, templateState.modelFailure]
        .filter(Boolean)
        .join('\n'),
    );
    renderDiagnostics();
    renderTemplateList();
    renderModelOptions();
    renderDraft();
  }
  function resetTemplates() {
    templateState.request++;
    templateState.cwd = '';
    templateState.data = undefined;
    templateState.toolSettings = undefined;
    templateState.modelFailure = '';
    templateState.busy = false;
    templateState.loading = false;
    templateState.choosing = false;
    templateState.failure = '';
    templateState.message = '';
    templateState.selectedKey = undefined;
    templateState.draft = undefined;
    templateState.deleteConfirmation = false;
    templateState.operation = '';
    renderTemplates();
  }
  async function loadTemplates() {
    if (!templateState.cwd || disposed) {
      renderTemplates();
      return;
    }
    const request = ++templateState.request;
    templateState.loading = true;
    templateState.failure = '';
    templateState.message = '';
    templateState.toolSettings = undefined;
    templateState.modelFailure = '';
    renderTemplates();
    try {
      const [data, models] = await Promise.all([
        api.listAgentTemplates(templateState.cwd),
        api.getToolSettings(selected?.()?.session?.id).then(
          value => ({value}),
          error => ({error: errorText(error)}),
        ),
      ]);
      if (disposed || request !== templateState.request) return;
      templateState.data = data;
      templateState.toolSettings = models.value;
      templateState.modelFailure = models.error
        ? `Could not load agent models: ${models.error}`
        : '';
      if (templateState.selectedKey) {
        const updated = selectedTemplate();
        if (updated) templateState.draft = editableDraft(updated);
        else {
          templateState.selectedKey = undefined;
          templateState.draft = undefined;
        }
      }
    } catch (error) {
      if (!disposed && request === templateState.request)
        templateState.failure = errorText(error);
    } finally {
      if (!disposed && request === templateState.request) {
        templateState.loading = false;
        renderTemplates();
      }
    }
  }
  async function openTemplates() {
    if (disposed || templatesButton.disabled || templatesDialog.open) return;
    hideMenu();
    resetTemplates();
    templateState.cwd = currentCwd();
    renderTemplates();
    templatesDialog.showModal();
    await loadTemplates();
    if (!disposed && templatesDialog.open) $('agent-template-new').focus();
  }
  async function chooseTemplatesFolder() {
    if (
      templateState.busy ||
      templateState.loading ||
      templateState.choosing ||
      !api?.chooseFolder
    )
      return;
    templateState.choosing = true;
    templateState.failure = '';
    templateState.message = '';
    renderTemplates();
    let changed = false;
    try {
      const cwd = await api.chooseFolder();
      if (disposed || !templatesDialog.open || !cwd) return;
      templateState.cwd = cwd;
      templateState.data = undefined;
      templateState.selectedKey = undefined;
      templateState.draft = undefined;
      templateState.deleteConfirmation = false;
      changed = true;
    } catch (error) {
      if (!disposed) templateState.failure = errorText(error);
    } finally {
      templateState.choosing = false;
      if (!disposed) renderTemplates();
    }
    if (changed && !disposed && templatesDialog.open) await loadTemplates();
  }
  function selectTemplate(template) {
    if (templateState.busy) return;
    templateState.selectedKey = templateIdentity(template);
    templateState.draft = editableDraft(template);
    templateState.deleteConfirmation = false;
    templateState.failure = '';
    templateState.message = '';
    renderTemplates();
    $('agent-template-name').focus();
  }
  function createTemplate() {
    if (templateState.busy || !templateState.cwd) return;
    templateState.selectedKey = undefined;
    templateState.draft = blankDraft();
    templateState.deleteConfirmation = false;
    templateState.failure = '';
    templateState.message = '';
    renderTemplates();
    $('agent-template-id').focus();
  }
  function readDraft() {
    if (!templateState.draft) return;
    templateState.draft = {
      ...templateState.draft,
      scope: $('agent-template-scope').value,
      id: $('agent-template-id').value,
      name: $('agent-template-name').value,
      description: $('agent-template-description').value,
      mode: $('agent-template-mode').value,
      context: $('agent-template-context').value,
      model: $('agent-template-model').value,
      thinkingLevel: $('agent-template-thinking').value,
      hidden: $('agent-template-hidden').value,
      disabled: $('agent-template-disabled').value,
      color: $('agent-template-color').value,
      steps: $('agent-template-steps').value,
      instructions: $('agent-template-instructions').value,
      permissions: $('agent-template-permissions').value,
    };
    const color = $('agent-template-color-indicator');
    const validColor = /^#[0-9a-f]{6}$/i.test(templateState.draft.color);
    color.style.backgroundColor = validColor ? templateState.draft.color : '';
    color.classList.toggle('empty', !validColor);
    $('agent-template-context-note').hidden =
      templateState.draft.context !== 'task';
    $('agent-template-source').textContent =
      draftSourcePath() || 'Available after choosing a folder';
  }
  function optionalBoolean(value, label) {
    if (value === '') return undefined;
    if (!['true', 'false'].includes(value))
      throw new Error(`${label} must use one of the listed values.`);
    return value === 'true';
  }
  function optionalSteps(value) {
    if (!value.trim()) return undefined;
    const steps = Number(value);
    if (!Number.isSafeInteger(steps) || steps < 1)
      throw new Error('Steps must be a positive integer.');
    return steps;
  }
  function optionalPermissions(value) {
    if (!value.trim()) return undefined;
    let permissions;
    try {
      permissions = JSON.parse(value);
    } catch (error) {
      throw new Error(`Permissions must be valid JSON. ${errorText(error)}`);
    }
    if (!Array.isArray(permissions))
      throw new Error('Permissions must be a JSON list.');
    for (const [index, permission] of permissions.entries()) {
      const validObject =
        permission &&
        typeof permission === 'object' &&
        !Array.isArray(permission);
      const keys = validObject ? Object.keys(permission) : [];
      if (
        !validObject ||
        keys.some(key => !['action', 'resource', 'effect'].includes(key)) ||
        typeof permission.action !== 'string' ||
        !permission.action ||
        typeof permission.resource !== 'string' ||
        !permission.resource ||
        !PERMISSION_EFFECTS.has(permission.effect)
      )
        throw new Error(
          `Permission ${index + 1} must contain action, resource, and an allow, ask, or deny effect.`,
        );
    }
    return permissions;
  }
  function updateSavedTemplate(saved) {
    const current = templateState.data || {
      templates: [],
      allTemplates: [],
      sources: [],
      diagnostics: [],
    };
    const templates = [...(current.allTemplates || [])];
    const index = templates.findIndex(
      template => templateIdentity(template) === templateIdentity(saved),
    );
    if (index === -1) templates.push(saved);
    else templates[index] = saved;
    templateState.data = {...current, allTemplates: templates};
  }
  async function saveTemplate(event) {
    event.preventDefault();
    if (
      templateState.busy ||
      templateState.loading ||
      !templateState.cwd ||
      !templateState.draft
    )
      return;
    readDraft();
    const draft = templateState.draft;
    let input;
    try {
      const id = draft.id;
      const color = draft.color.trim();
      if (!id) throw new Error('ID is required.');
      if (draft.mode && !AGENT_MODES.has(draft.mode))
        throw new Error('Mode must be primary, subagent, or all.');
      if (draft.context && !AGENT_CONTEXTS.has(draft.context))
        throw new Error('Context must be workspace or task.');
      if (color && !/^#[0-9a-f]{6}$/i.test(color))
        throw new Error('Color must be a six-digit hex value such as #ff6b6b.');
      const steps = optionalSteps(draft.steps);
      const permissions = optionalPermissions(draft.permissions);
      const hidden = optionalBoolean(draft.hidden, 'Visibility');
      const disabled = optionalBoolean(draft.disabled, 'Availability');
      const selected = selectedTemplate();
      const sourcePath =
        selected &&
        selected.scope !== 'builtin' &&
        selected.scope === draft.scope &&
        selected.id === id
          ? selected.sourcePath
          : undefined;
      input = {
        scope: draft.scope,
        id,
        ...(sourcePath ? {sourcePath} : {}),
        ...(draft.name.trim() ? {name: draft.name.trim()} : {}),
        ...(draft.description.trim()
          ? {description: draft.description.trim()}
          : {}),
        ...(draft.mode ? {mode: draft.mode} : {}),
        ...(draft.context ? {context: draft.context} : {}),
        ...(draft.model.trim() ? {model: draft.model.trim()} : {}),
        ...(draft.thinkingLevel ? {thinkingLevel: draft.thinkingLevel} : {}),
        ...(hidden !== undefined ? {hidden} : {}),
        ...(disabled !== undefined ? {disabled} : {}),
        ...(color ? {color} : {}),
        ...(steps !== undefined ? {steps} : {}),
        ...(draft.instructions.trim()
          ? {instructions: draft.instructions.trim()}
          : {}),
        ...(permissions !== undefined ? {permissions} : {}),
      };
    } catch (error) {
      templateState.failure = errorText(error);
      templateState.message = '';
      renderTemplates();
      return;
    }
    templateState.busy = true;
    templateState.operation = 'save';
    templateState.failure = '';
    templateState.message = '';
    renderTemplates();
    try {
      const saved = await api.saveAgentTemplate(templateState.cwd, input);
      if (disposed) return;
      updateSavedTemplate(saved);
      templateState.selectedKey = templateIdentity(saved);
      templateState.draft = draftFrom(saved);
      templateState.deleteConfirmation = false;
      templateState.message = 'Saved.';
    } catch (error) {
      if (!disposed) templateState.failure = errorText(error);
    } finally {
      templateState.busy = false;
      templateState.operation = '';
      if (!disposed) renderTemplates();
    }
  }
  function askDeleteTemplate() {
    if (
      !templateState.selectedKey ||
      selectedTemplate()?.scope === 'builtin' ||
      templateState.busy
    )
      return;
    templateState.deleteConfirmation = true;
    templateState.failure = '';
    templateState.message = '';
    renderDraft();
    $('agent-template-delete-confirm').focus();
  }
  function cancelDeleteTemplate() {
    templateState.deleteConfirmation = false;
    renderDraft();
    $('agent-template-delete').focus();
  }
  async function deleteTemplate() {
    const template = selectedTemplate();
    if (!template || template.scope === 'builtin' || templateState.busy) return;
    templateState.busy = true;
    templateState.operation = 'delete';
    templateState.failure = '';
    templateState.message = '';
    renderTemplates();
    try {
      await api.deleteAgentTemplate(templateState.cwd, {
        scope: template.scope,
        id: template.id,
        sourcePath: template.sourcePath,
      });
      if (disposed) return;
      templateState.data = {
        ...templateState.data,
        allTemplates: allTemplates().filter(
          item => templateIdentity(item) !== templateIdentity(template),
        ),
      };
      templateState.selectedKey = undefined;
      templateState.draft = undefined;
      templateState.deleteConfirmation = false;
      templateState.message = 'Deleted.';
    } catch (error) {
      if (!disposed) templateState.failure = errorText(error);
    } finally {
      templateState.busy = false;
      templateState.operation = '';
      if (!disposed) renderTemplates();
    }
  }

  listen(newButton, 'click', () => void openCreate());
  if (menuNewButton) listen(menuNewButton, 'click', () => void openCreate());
  listen($('new-agent-close'), 'click', () => {
    if (!createState.busy) closeDialog(newDialog);
  });
  listen($('new-agent-cancel'), 'click', () => {
    if (!createState.busy) closeDialog(newDialog);
  });
  listen(newDialog, 'cancel', event => {
    if (createState.busy) event.preventDefault();
  });
  listen(newDialog, 'close', () => {
    if (!newDialog.open) resetCreate();
  });
  listen(
    $('new-agent-choose-folder'),
    'click',
    () => void chooseCreateFolder(),
  );
  listen($('new-agent-recent'), 'change', event => {
    const cwd = event.target.value;
    if (createState.recentFolders.includes(cwd))
      void selectCreateWorkspace(cwd);
  });
  listen($('new-agent-form'), 'submit', submitCreate);

  listen(templatesButton, 'click', () => void openTemplates());
  listen($('agent-templates-close'), 'click', () => {
    if (!templateState.busy) closeDialog(templatesDialog);
  });
  listen(templatesDialog, 'cancel', event => {
    if (templateState.busy) event.preventDefault();
  });
  listen(templatesDialog, 'close', () => {
    if (!templatesDialog.open) resetTemplates();
  });
  listen(
    $('agent-templates-choose-folder'),
    'click',
    () => void chooseTemplatesFolder(),
  );
  listen($('agent-template-new'), 'click', createTemplate);
  if ($('agent-template-picker')) {
    listen($('agent-template-picker'), 'change', event => {
      const template = allTemplates().find(
        item => templateIdentity(item) === event.target.value,
      );
      if (template) selectTemplate(template);
    });
  }
  listen($('agent-template-form'), 'submit', saveTemplate);
  for (const id of [
    'agent-template-scope',
    'agent-template-id',
    'agent-template-name',
    'agent-template-description',
    'agent-template-mode',
    'agent-template-context',
    'agent-template-model',
    'agent-template-thinking',
    'agent-template-hidden',
    'agent-template-disabled',
    'agent-template-color',
    'agent-template-steps',
    'agent-template-instructions',
    'agent-template-permissions',
  ]) {
    listen($(id), 'input', readDraft);
    if ($(id).tagName === 'SELECT') listen($(id), 'change', readDraft);
  }
  listen($('agent-template-delete'), 'click', askDeleteTemplate);
  listen($('agent-template-delete-cancel'), 'click', cancelDeleteTemplate);
  listen(
    $('agent-template-delete-confirm'),
    'click',
    () => void deleteTemplate(),
  );

  renderAvailability();
  resetCreate();
  resetTemplates();
  return {
    render: renderAvailability,
    dispose() {
      disposed = true;
      createState.request++;
      createState.recentRequest++;
      templateState.request++;
      for (const remove of listeners) remove();
      closeDialog(newDialog);
      closeDialog(templatesDialog);
    },
  };
}
