import {nativeCommand, parseSlashCommand} from './command-catalog.js';

/** Return undefined for SDK/extension commands, false for a cancelled action. */
export function createNativeCommandRouter({api, newSession, hotkeys}) {
  async function dispatch(command, {data, submission}) {
    const {name, args} = command;
    if (args) throw new Error(`Usage: /${name}`);
    switch (name) {
      case 'new':
        return newSession(submission);
      case 'copy': {
        // The dashboard preview can be truncated and can include custom messages.
        // Resolve the complete real assistant response in the owning SDK parent.
        const result = await api.desktopCommand('copy', {
          sessionId: data.session.id,
        });
        if (!result?.ok)
          throw new Error('The assistant message could not be copied.');
        return true;
      }
      case 'hotkeys':
        await hotkeys();
        return true;
      case 'quit': {
        const result = await api.desktopCommand('quit', {});
        return result?.cancelled === false;
      }
    }
  }
  return request => {
    const command = parseSlashCommand(request.prompt);
    if (!command || nativeCommand(command.name)?.target !== 'desktop') return;
    return dispatch(command, request);
  };
}

/** Observe every parent, including those not currently selected in the window. */
export function createNavigationReceiver({api, opened, failed}) {
  const seen = new Set();
  let queue = Promise.resolve();
  return hub => {
    for (const data of hub.sessions) {
      const navigation = data.ui?.navigation;
      if (!navigation) continue;
      const originId = data.session.id;
      const key = JSON.stringify([originId, navigation.id]);
      if (seen.has(key)) continue;
      seen.add(key);
      let acknowledged = false;
      let result;
      const open = async () => {
        // Creating a replacement may close the origin. Release its command first.
        if (!acknowledged) {
          await api.respondToDialog(originId, navigation.id);
          acknowledged = true;
        }
        result ||= await api.createSession({
          cwd: navigation.cwd,
          sessionId: navigation.sessionId,
        });
        await opened(result.id, navigation.draft);
      };
      const attempt = () =>
        open().catch(cause =>
          failed(cause, () => {
            queue = queue.then(attempt);
            return queue;
          }),
        );
      queue = queue.then(attempt);
    }
    return queue;
  };
}
