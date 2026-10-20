import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const marker = '// VarisDev: reuse issued OpenAI registrations (v1).';

/** Compatibility patch for Pi 1.3 until its OAuth flow supports returning sign-in. */
export function patchOpenAIRegistration(source) {
  if (source.startsWith(marker)) return source;
  const replace = (before, after) => {
    if (source.split(before).length !== 2)
      throw new Error(
        'Pi OpenAI OAuth changed; review the registration reuse patch.',
      );
    source = source.replace(before, after);
  };
  replace(
    '// every login registers a new client with this ID; OpenAI returns the issued client ID in the callback',
    '// Only first-time registration uses this ID; returning sign-in uses the issued client ID.',
  );
  replace(
    'function authorizationResultFromCallback(url, expectedState) {',
    'function authorizationResultFromCallback(url, expectedState, expectedClientId) {',
  );
  replace(
    '    const clientId = url.searchParams.get("client_id")?.trim();\n    if (!clientId)',
    `    const returnedClientId = url.searchParams.get("client_id")?.trim();
    if (expectedClientId && returnedClientId && returnedClientId !== expectedClientId)
        throw new Error("OpenAI OAuth callback client ID does not match the selected registration");
    const clientId = returnedClientId || expectedClientId;
    if (!clientId || clientId === DYNAMIC_CLIENT_ID)`,
  );
  replace(
    '                    sendHtml(response, 400, oauthErrorHtml(message));\n                    return;',
    `                    sendHtml(response, 400, oauthErrorHtml(message));
                    if (url.searchParams.get("state") === expectedState) rejectResult(error);
                    return;`,
  );
  replace(
    'function authorizationResultFromManualInput(input, expectedState) {',
    'function authorizationResultFromManualInput(input, expectedState, expectedClientId) {',
  );
  replace(
    'return authorizationResultFromCallback(url, expectedState);',
    'return authorizationResultFromCallback(url, expectedState, expectedClientId);',
  );
  replace(
    'function startCallbackServer(expectedState) {',
    'function startCallbackServer(expectedState, expectedClientId) {',
  );
  replace(
    'authorizationResult = authorizationResultFromCallback(url, expectedState);',
    'authorizationResult = authorizationResultFromCallback(url, expectedState, expectedClientId);',
  );
  replace(
    '    const hostId = agentHostId(options?.getDeviceId?.());',
    `    const hostId = agentHostId(options?.getDeviceId?.());
    const registration = options?.openaiRegistration;
    const clientId = await registration?.load(interaction);
    interaction.signal.throwIfAborted();`,
  );
  replace(
    'const callback = await startCallbackServer(state).catch',
    'const callback = await startCallbackServer(state, clientId).catch',
  );
  replace(
    '        client_id: DYNAMIC_CLIENT_ID,\n        agent_name_hint: options?.agentName ?? AGENT_NAME_HINT,',
    `        client_id: clientId ?? DYNAMIC_CLIENT_ID,
        ...(clientId ? {} : { agent_name_hint: options?.agentName ?? AGENT_NAME_HINT }),`,
  );
  replace(
    'authorizationResultFromManualInput(input, state)',
    'authorizationResultFromManualInput(input, state, clientId)',
  );
  replace(
    '        return await exchangeAuthorizationCode(result.code, verifier, result.clientId, interaction.signal);',
    `        // Retain registration even if code exchange fails; retry must not register another app.
        await registration?.save(result.clientId);
        interaction.signal.throwIfAborted();
        return await exchangeAuthorizationCode(result.code, verifier, result.clientId, interaction.signal);`,
  );
  replace(
    '    login: loginOpenAIChatGPT,',
    '    login: Object.assign(loginOpenAIChatGPT, { varisdevRegistrationReuse: true }),',
  );
  return `${marker}\n${source}`;
}

export async function patchBundledOpenAIRegistration(desktop) {
  const path = join(
    desktop,
    'node_modules/@earendil-works/pi-ai/dist/auth/oauth/openai-chatgpt.js',
  );
  const original = await readFile(path, 'utf8');
  const patched = patchOpenAIRegistration(original);
  if (patched !== original) await writeFile(path, patched);
}
