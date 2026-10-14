/** Public, SDK independent JSON contract for tool results and displayed messages. */
export const VISUALIZATION_VERSION = 1 as const;
export const MAX_VISUALIZATION_BLOCKS = 8;
export const MAX_VISUALIZATION_MARKDOWN = 16000;

export type ImageVisualization = {
  type: 'image';
  path: string;
  label?: string;
};
export type MarkdownVisualization = {type: 'markdown'; text: string};
export type ProgressVisualization = {
  type: 'progress';
  value: number;
  total?: number;
  label?: string;
};
export type VisualizationBlock =
  ImageVisualization | MarkdownVisualization | ProgressVisualization;
export type VisualizationMetadata = {
  version: typeof VISUALIZATION_VERSION;
  blocks: VisualizationBlock[];
};
export type VisualizationDetails = {varisdev: VisualizationMetadata};
export type VisualResult = {
  content: Array<{type: 'text'; text: string}>;
  details: VisualizationDetails;
};

/** Add these details to a tool result or a displayed custom message. */
export function visualizationDetails(
  blocks: readonly VisualizationBlock[],
): VisualizationDetails {
  return {
    varisdev: {
      version: VISUALIZATION_VERSION,
      blocks: blocks.map(block => ({...block})),
    },
  };
}

/** A ready to return tool result; normal text remains available to the model. */
export function visualResult(
  text: string,
  blocks: readonly VisualizationBlock[],
): VisualResult {
  return {
    content: [{type: 'text', text}],
    details: visualizationDetails(blocks),
  };
}

/** The image data itself is loaded separately using the opaque registry ID. */
export type ConversationImage = {
  type: 'image';
  id: string;
  name: string;
  path?: string;
  width?: number;
  height?: number;
  label?: string;
};
export type DisplayVisualization =
  ConversationImage | MarkdownVisualization | ProgressVisualization;
export type ConversationVisualizations = {
  visualizations?: DisplayVisualization[];
  visualizationErrors?: string[];
};
export type ConversationImageVariant = 'thumbnail' | 'full';
export type ConversationImageResponse = {
  src: string;
  width: number;
  height: number;
  name: string;
};
