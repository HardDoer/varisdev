import type {MessageBoxOptions} from 'electron';

/** Bound renderer-controlled clipboard payloads to one Mi UTF-16 code units. */
export const desktopCopyTextLimit = 1024 * 1024;

interface DesktopCommandDependencies {
  clipboard: {writeText: (text: string) => void};
  lastAssistantText: (sessionId: string) => string;
  showQuitConfirmation: (
    options: MessageBoxOptions,
  ) => Promise<{response: number}>;
  quit: () => void;
}

type DesktopCommandResult = {ok: true} | {cancelled: boolean};

function inputRecord(input: unknown): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    (Object.getPrototypeOf(input) !== Object.prototype &&
      Object.getPrototypeOf(input) !== null)
  )
    throw new Error('Desktop commands require an input object.');
  return input as Record<string, unknown>;
}

/** Explicit native allowlist; never accepts shell commands, paths or URLs. */
export class DesktopCommands {
  private pendingQuit?: Promise<{cancelled: boolean}>;
  private readonly dependencies: DesktopCommandDependencies;

  constructor(dependencies: DesktopCommandDependencies) {
    this.dependencies = dependencies;
  }

  async execute(
    action: unknown,
    input: unknown,
  ): Promise<DesktopCommandResult> {
    if (action !== 'copy' && action !== 'quit')
      throw new Error('Unknown desktop command.');
    const value = inputRecord(input);
    const keys = Reflect.ownKeys(value);
    if (action === 'copy') {
      let text: string;
      if (keys.length === 1 && keys[0] === 'sessionId') {
        if (
          typeof value.sessionId !== 'string' ||
          !value.sessionId ||
          value.sessionId.length > 256
        )
          throw new Error('Copy requires a valid workspace ID.');
        // Resolve the authoritative native transcript, never the dashboard preview.
        // Only renderer-supplied text is bounded; native text is copied in full.
        text = this.dependencies.lastAssistantText(value.sessionId);
      } else {
        if (
          keys.length !== 1 ||
          keys[0] !== 'text' ||
          typeof value.text !== 'string' ||
          value.text.length > desktopCopyTextLimit
        )
          throw new Error(
            `Copy requires a session ID or only text of at most ${desktopCopyTextLimit} characters.`,
          );
        text = value.text;
      }
      this.dependencies.clipboard.writeText(text);
      return {ok: true};
    }
    if (keys.length !== 0)
      throw new Error('Quit requires an empty input object.');
    // Repeated requests share one native confirmation rather than stacking dialogs.
    this.pendingQuit ??= this.confirmQuit().finally(() => {
      this.pendingQuit = undefined;
    });
    return this.pendingQuit;
  }

  private async confirmQuit(): Promise<{cancelled: boolean}> {
    const {response} = await this.dependencies.showQuitConfirmation({
      type: 'question',
      title: 'Quit VarisDev?',
      message: 'Quit VarisDev?',
      detail:
        'Running conversations and agents will be stopped before quitting.',
      buttons: ['Cancel', 'Quit VarisDev'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response !== 1) return {cancelled: true};
    // app.quit(), not app.exit(): the existing before-quit cleanup must run.
    this.dependencies.quit();
    return {cancelled: false};
  }
}
