import {Buffer} from 'node:buffer';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';

async function board(cwd, path = 'PLAN.md', image) {
  const file = await open(resolve(cwd, path), 'r');
  let text;
  try {
    const buffer = Buffer.alloc(16001);
    const {bytesRead} = await file.read(buffer);
    if (bytesRead > 16000) throw new Error('Choose a plan smaller than 16 KB.');
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await file.close();
  }
  const tasks = [...text.matchAll(/^\s*-\s+\[([ xX])\]/gm)];
  const complete = tasks.filter(task => task[1].toLowerCase() === 'x').length;
  const blocks = [
    {
      type: 'progress',
      value: complete,
      total: tasks.length || 1,
      label: 'Tasks complete',
    },
    {type: 'markdown', text},
  ];
  if (image)
    blocks.push({
      type: 'image',
      path: image,
      label: 'Project preview',
    });
  return {
    content: [
      {
        type: 'text',
        text: `${path}: ${complete}/${tasks.length} tasks complete.`,
      },
    ],
    details: {varisdev: {version: 1, blocks}},
  };
}

export default function projectBoard(api) {
  api.registerTool({
    name: 'project_board',
    label: 'Project board',
    description:
      'Show a Markdown plan, task progress, and an optional local image in VarisDev.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Markdown plan, relative to the project. Defaults to PLAN.md.',
        },
        image: {
          type: 'string',
          description: 'Optional local image to show with the plan.',
        },
      },
      additionalProperties: false,
    },
    async execute(_id, {path, image}, _signal, _update, context) {
      return board(context.cwd, path, image);
    },
  });
  api.registerCommand('project-board', {
    description: 'Show a plan in the conversation; optionally pass its path.',
    async handler(args, context) {
      const result = await board(context.cwd, args.trim() || 'PLAN.md');
      api.sendMessage({
        customType: 'project-board',
        content: result.content,
        details: result.details,
        display: true,
      });
    },
  });
}
