import {
  parseArgs,
  SessionManager,
  type Args,
} from '@earendil-works/pi-coding-agent';
import type {ImageContent} from '@earendil-works/pi-ai';
import {mkdir, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, sep} from 'node:path';
import type {DesktopStartup} from '../desktop/startup.ts';
import {piModuleURL} from '../runtime/pi-paths.ts';

export async function restoreDesktopSession(
  startup: DesktopStartup,
  agentDir: string,
): Promise<SessionManager> {
  let manager: SessionManager;
  if (startup.sessionFile) {
    let sessionFile = startup.sessionFile;
    let sessionDir = startup.sessionDir;
    const belongsToSettings = (path: string) => {
      const pathFromSettings = relative(agentDir, path);
      return (
        pathFromSettings !== '..' &&
        !pathFromSettings.startsWith(`..${sep}`) &&
        !isAbsolute(pathFromSettings)
      );
    };
    if (!belongsToSettings(sessionFile) || !belongsToSettings(sessionDir)) {
      sessionDir = SessionManager.create(startup.cwd).getSessionDir();
      sessionFile = join(sessionDir, basename(startup.sessionFile));
    }
    // The source is idle; copy buffered entries into the selected settings directory.
    await mkdir(dirname(sessionFile), {recursive: true});
    await writeFile(
      sessionFile,
      startup.entries.map(entry => JSON.stringify(entry)).join('\n') + '\n',
    );
    manager = SessionManager.open(sessionFile, sessionDir, startup.cwd);
  } else {
    manager = SessionManager.inMemory(startup.cwd, undefined, startup.entries);
  }
  if (startup.leafId) manager.branch(startup.leafId);
  else manager.resetLeaf();
  return manager;
}

export async function desktopInitialPrompts(
  argv: string[],
  autoResizeImages: boolean,
): Promise<Array<{text: string; images?: ImageContent[]}>> {
  const args = parseArgs(argv);
  const prompts = args.messages.map(text => ({
    text,
    images: undefined as ImageContent[] | undefined,
  }));
  if (args.fileArgs.length) {
    // Pi's file processor is distributed with the SDK but is not a root export.
    const files = (await import(piModuleURL('cli/file-processor.js').href)) as {
      processFileArguments(
        files: string[],
        options: {autoResizeImages: boolean},
      ): Promise<{text: string; images: ImageContent[]}>;
    };
    const content = await files.processFileArguments(args.fileArgs, {
      autoResizeImages,
    });
    if (!prompts.length) prompts.push({text: '', images: undefined});
    prompts[0].text = content.text + prompts[0].text;
    prompts[0].images = content.images;
  }
  return prompts;
}

export function desktopResourceOptions(args: Args) {
  return {
    additionalExtensionPaths: args.extensions,
    additionalSkillPaths: args.skills,
    additionalPromptTemplatePaths: args.promptTemplates,
    additionalThemePaths: args.themes,
    noExtensions: args.noExtensions,
    disabledBuiltinExtensions: args.noMcp ? ['mcp'] : undefined,
    noSkills: args.noSkills,
    noPromptTemplates: args.noPromptTemplates,
    noThemes: args.noThemes,
    noContextFiles: args.noContextFiles,
    systemPrompt: args.systemPrompt,
    appendSystemPrompt: args.appendSystemPrompt,
  };
}
