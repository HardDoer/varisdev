import {type ExtensionAPI} from '@earendil-works/pi-coding-agent';
import {Type} from 'typebox';

const MEMORY_URL = 'http://127.0.0.1:8000';

const globalSaveSchema = Type.Object({
  keyword: Type.String({description: 'Keyword to associate with the memory entry.'}),
  content: Type.String({description: 'The content of the memory to save.'}),
});

const globalSearchSchema = Type.Object({
  q: Type.String({description: 'The search query to find relevant memories.'}),
});

const sessionSaveSchema = Type.Object({
  session_id: Type.String({description: 'The unique identifier for the current session.'}),
  turn_index: Type.Number({description: 'The index of the current turn in the session.'}),
  content: Type.String({description: 'The content of the session entry to save.'}),
});

const sessionSearchSchema = Type.Object({
  session_id: Type.String({description: 'The unique identifier for the session to search.'}),
  turn_start: Type.Optional(
    Type.Number({description: 'The turn index to start searching from. If omitted, returns all.'}),
  ),
});

const sessionSummarizeSchema = Type.Object({
  session_id: Type.String({description: 'The unique identifier for the session to summarize.'}),
  summary: Type.String({description: 'The summary of the session to store in global memory.'}),
});

async function checkMemoryService(): Promise<void> {
  try {
    const response = await fetch(`${MEMORY_URL}/docs`, {method: 'HEAD'});
    if (!response.ok) {
      throw new Error(`Memory service returned status ${response.status}`);
    }
  } catch (error) {
    throw new Error(
      `Local memory instance not found at ${MEMORY_URL}. Please ensure the Docker container is running.`,
    );
  }
}

export function registerMemoryTools(pi: ExtensionAPI): void {
  pi.registerTool<typeof globalSaveSchema, {status: string}>({
    name: 'memory_global_save',
    label: 'Save Global Memory',
    description: 'Save a piece of information to the long-term global memory associated with a keyword.',
    parameters: globalSaveSchema,
    async execute(_toolCallId, params) {
      await checkMemoryService();
      const response = await fetch(`${MEMORY_URL}/global/save`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error(`Failed to save global memory: ${response.statusText}`);
      return {content: [{type: 'text', text: 'Global memory saved.'}], details: await response.json()};
    },
  });

  pi.registerTool<typeof globalSearchSchema, any[]>({
    name: 'memory_global_search',
    label: 'Search Global Memory',
    description: 'Search for information in the long-term global memory using a keyword.',
    parameters: globalSearchSchema,
    async execute(_toolCallId, params) {
      await checkMemoryService();
      const url = new URL(`${MEMORY_URL}/global/search`);
      url.searchParams.append('q', params.q);
      const response = await fetch(url.toString());
      if (!response.ok) throw new Error(`Failed to search global memory: ${response.statusText}`);
      const data = await response.json();
      return {
        content: [{type: 'text', text: data.length > 0 ? JSON.stringify(data, null, 2) : 'No matching memories found.'}],
        details: data,
      };
    },
  });

  pi.registerTool<typeof sessionSaveSchema, {status: string}>({
    name: 'memory_session_save',
    label: 'Save Session Memory',
    description: 'Save the current turn content to the short-term session memory.',
    parameters: sessionSaveSchema,
    async execute(_toolCallId, params) {
      await checkMemoryService();
      const response = await fetch(`${MEMORY_URL}/session/save`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(params),
      });
      if (!response.ok) throw new Error(`Failed to save session memory: ${response.statusText}`);
      return {content: [{type: 'text', text: 'Session memory saved.'}], details: await response.json()};
    },
  });

  pi.registerTool<typeof sessionSearchSchema, any[]>({
    name: 'memory_session_search',
    label: 'Search Session Memory',
    description: 'Retrieve memories from a specific session, optionally starting from a certain turn.',
    parameters: sessionSearchSchema,
    async execute(_toolCallId, params) {
      await checkMemoryService();
      const url = new URL(`${MEMORY_URL}/session/search`);
      url.searchParams.append('session_id', params.session_id);
      if (params.turn_start !== undefined) {
        url.searchParams.append('turn_start', params.turn_start.toString());
      }
      const response = await fetch(url.toString());
      if (!response.ok) throw new Error(`Failed to search session memory: ${response.statusText}`);
      const data = await response.json();
      return {
        content: [{type: 'text', text: data.length > 0 ? JSON.stringify(data, null, 2) : 'No session memories found.'}],
        details: data,
      };
    },
  });

  pi.registerTool<typeof sessionSummarizeSchema, {status: string}>({
    name: 'memory_session_summarize',
    label: 'Summarize Session',
    description: 'Save a summary of a session to the global memory.',
    parameters: sessionSummarizeSchema,
    async execute(_toolCallId, params) {
      await checkMemoryService();
      const url = new URL(`${MEMORY_URL}/session/summarize`);
      url.searchParams.append('session_id', params.session_id);
      url.searchParams.append('summary', params.summary);
      const response = await fetch(url.toString(), {method: 'POST'});
      if (!response.ok) throw new Error(`Failed to summarize session: ${response.statusText}`);
      return {content: [{type: 'text', text: 'Session summarized and stored in global memory.'}], details: await response.json()};
    },
  });
}
