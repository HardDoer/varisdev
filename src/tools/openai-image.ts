import OpenAI from "openai";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "typebox";

const DEFAULT_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_IMAGE_SIZE = "1024x1024";
const DEFAULT_IMAGE_QUALITY = "auto";
const DEFAULT_OUTPUT_DIR = "generated-images";
const DEFAULT_OUTPUT_FORMAT = "png";
const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_IMAGES = 4;
const API_KEY_ENV_VAR = "OPENAI_API_KEY";

const openAIImageSchema = Type.Object({
	prompt: Type.String({ description: "Detailed prompt for the image to generate." }),
	size: Type.Optional(
		Type.String({ description: `Image size, for example 1024x1024, 1024x1536, 1536x1024, or auto. Defaults to process.env.OPENAI_IMAGE_SIZE or ${DEFAULT_IMAGE_SIZE}.` }),
	),
	quality: Type.Optional(
		Type.String({
			description: `Image quality, for example auto, low, medium, high, standard, or hd. The agent should choose this from the user's request; defaults to ${DEFAULT_IMAGE_QUALITY}.`,
			default: DEFAULT_IMAGE_QUALITY,
		}),
	),
	n: Type.Optional(
		Type.Number({
			description: `Number of images to generate. Defaults to 1. Maximum ${MAX_IMAGES} to avoid accidental high-cost calls.`,
			minimum: 1,
			maximum: MAX_IMAGES,
		}),
	),
	outputDir: Type.Optional(
		Type.String({ description: `Directory where generated image files are saved. Relative paths resolve under the current project. Defaults to process.env.OPENAI_IMAGE_OUTPUT_DIR or ${DEFAULT_OUTPUT_DIR}.` }),
	),
	filenamePrefix: Type.Optional(
		Type.String({ description: "Optional filename prefix for saved images. The tool adds a timestamp, image index, and random suffix." }),
	),
	outputFormat: Type.Optional(
		Type.String({ description: `Output image format for gpt-image models: png, jpeg, or webp. Defaults to process.env.OPENAI_IMAGE_OUTPUT_FORMAT or ${DEFAULT_OUTPUT_FORMAT}.` }),
	),
	background: Type.Optional(
		Type.String({ description: "Optional background for supported models, for example auto, opaque, or transparent." }),
	),
	outputCompression: Type.Optional(
		Type.Number({ description: "Optional output compression for jpeg/webp on supported models, 0-100.", minimum: 0, maximum: 100 }),
	),
	moderation: Type.Optional(Type.String({ description: "Optional moderation strictness for supported models, for example auto or low." })),
	user: Type.Optional(Type.String({ description: "Optional end-user identifier sent to OpenAI for abuse monitoring." })),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Request timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}. Maximum ${MAX_TIMEOUT_MS}.`,
			minimum: 1,
			maximum: MAX_TIMEOUT_MS,
		}),
	),
});

type GeneratedImageDetails = {
	path: string;
	mimeType: string;
	bytes: number;
	source: "base64" | "url";
	revisedPrompt?: string;
};

type OpenAIImageToolDetails = {
	request: {
		model: string;
		size: string;
		quality?: string;
		n: number;
		outputDir: string;
		outputFormat: string;
		timeoutMs: number;
		apiKeyEnvVar: string;
		baseURL?: string;
	};
	images: GeneratedImageDetails[];
};

function trimEnv(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

function getApiKey(): { apiKey: string; envVarName: string } {
	const apiKey = trimEnv(API_KEY_ENV_VAR);
	if (apiKey) return { apiKey, envVarName: API_KEY_ENV_VAR };
	throw new Error(`Missing OpenAI API key. Set process.env.${API_KEY_ENV_VAR}.`);
}

function envOrDefault(name: string, fallback: string): string {
	return trimEnv(name) ?? fallback;
}

function normalizeTimeout(timeoutMs?: number): number {
	if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) return DEFAULT_TIMEOUT_MS;
	return Math.min(Math.max(Math.round(timeoutMs), 1), MAX_TIMEOUT_MS);
}

function normalizeImageCount(n?: number): number {
	if (n === undefined || !Number.isFinite(n)) return 1;
	return Math.min(Math.max(Math.round(n), 1), MAX_IMAGES);
}

function stripAtPath(rawPath: string): string {
	return rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
}

function resolveOutputDir(cwd: string, outputDir?: string): string {
	return resolve(cwd, stripAtPath(outputDir?.trim() || envOrDefault("OPENAI_IMAGE_OUTPUT_DIR", DEFAULT_OUTPUT_DIR)));
}

function sanitizeFilenamePart(value: string | undefined, fallback: string): string {
	const sanitized = (value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
	return sanitized || fallback;
}

function normalizeOutputFormat(value: string | undefined): string {
	const format = (value ?? envOrDefault("OPENAI_IMAGE_OUTPUT_FORMAT", DEFAULT_OUTPUT_FORMAT)).trim().toLowerCase();
	return format === "jpg" ? "jpeg" : format;
}

function mimeTypeForFormat(format: string): string {
	if (format === "jpg" || format === "jpeg") return "image/jpeg";
	if (format === "webp") return "image/webp";
	return "image/png";
}

function extensionForMimeType(mimeType: string, fallbackFormat: string): string {
	const normalized = mimeType.split(";", 1)[0]?.trim().toLowerCase();
	if (normalized === "image/jpeg") return "jpg";
	if (normalized === "image/webp") return "webp";
	if (normalized === "image/png") return "png";
	if (fallbackFormat === "jpeg" || fallbackFormat === "jpg") return "jpg";
	if (fallbackFormat === "webp") return "webp";
	return "png";
}

function createOutputPath(outputDir: string, prefix: string, index: number, extension: string): string {
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	return join(outputDir, `${prefix}-${timestamp}-${index + 1}-${randomUUID().slice(0, 8)}.${extension}`);
}

function decodeBase64Image(data: string): Buffer {
	const commaIndex = data.indexOf(",");
	const base64 = commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
	return Buffer.from(base64, "base64");
}

async function fetchImageFromUrl(url: string, signal?: AbortSignal): Promise<{ bytes: Buffer; mimeType: string }> {
	const response = await fetch(url, { signal });
	if (!response.ok) {
		throw new Error(`Failed to download generated image: ${response.status} ${response.statusText}`);
	}

	const mimeType = response.headers.get("content-type") ?? "image/png";
	return { bytes: Buffer.from(await response.arrayBuffer()), mimeType };
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (typeof timer === "object" && timer && "unref" in timer) {
		(timer as { unref?: () => void }).unref?.();
	}
}

function createTimeoutSignal(timeoutMs: number, parentSignal?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(new Error(`OpenAI image generation timed out after ${timeoutMs}ms`)), timeoutMs);
	unrefTimer(timeout);

	const abortFromParent = () => controller.abort(parentSignal?.reason);
	if (parentSignal?.aborted) {
		abortFromParent();
	} else {
		parentSignal?.addEventListener("abort", abortFromParent, { once: true });
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timeout);
			parentSignal?.removeEventListener("abort", abortFromParent);
		},
	};
}

function makeGenerateRequest(params: {
	model: string;
	prompt: string;
	size: string;
	quality?: string;
	n: number;
	outputFormat: string;
	background?: string;
	outputCompression?: number;
	moderation?: string;
	user?: string;
}): Record<string, unknown> {
	const request: Record<string, unknown> = {
		model: params.model,
		prompt: params.prompt,
		n: params.n,
		size: params.size,
	};

	if (params.quality) request.quality = params.quality;
	if (params.background) request.background = params.background;
	if (params.outputCompression !== undefined) request.output_compression = Math.round(params.outputCompression);
	if (params.moderation) request.moderation = params.moderation;
	if (params.user) request.user = params.user;

	// The current GPT image models support output_format. Older DALL-E models may not,
	// so only send the default for GPT-image models unless the caller explicitly set it.
	if (params.model.startsWith("gpt-image") || params.outputFormat !== DEFAULT_OUTPUT_FORMAT || trimEnv("OPENAI_IMAGE_OUTPUT_FORMAT")) {
		request.output_format = params.outputFormat;
	}

	return request;
}

function formatResultText(images: GeneratedImageDetails[]): string {
	const lines = [`Generated ${images.length} image${images.length === 1 ? "" : "s"} with OpenAI.`];

	for (const [index, image] of images.entries()) {
		lines.push(`- ${image.path} (${image.mimeType}, ${formatSize(image.bytes)})`);
		if (image.revisedPrompt) {
			const revisedPrompt = truncateHead(image.revisedPrompt, { maxLines: 6, maxBytes: DEFAULT_MAX_BYTES });
			lines.push(`  revised prompt ${index + 1}: ${revisedPrompt.content}`);
		}
	}

	return lines.join("\n");
}

export function registerOpenAIImageTool(pi: ExtensionAPI): void {
	pi.registerTool<typeof openAIImageSchema, OpenAIImageToolDetails>({
		name: "openai_generate_image",
		label: "OpenAI Image",
		description: "Generate one or more images with the OpenAI Images API and save them as files in the current project.",
		promptSnippet: "Generate images with the OpenAI Images API and save them to project files.",
		promptGuidelines: [
			"Use openai_generate_image when the user asks to generate an AI image file through OpenAI.",
			"openai_generate_image uses process.env.OPENAI_API_KEY; never ask the user to paste the API key into tool arguments.",
			"openai_generate_image returns saved file paths; refer to those paths instead of embedding base64 image data in the final answer.",
			`Choose the quality parameter from the user's requested speed/detail/cost preference; use ${DEFAULT_IMAGE_QUALITY} when unspecified.`,
		],
		parameters: openAIImageSchema,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const { apiKey, envVarName } = getApiKey();
			const model = DEFAULT_IMAGE_MODEL;
			const size = params.size?.trim() || envOrDefault("OPENAI_IMAGE_SIZE", DEFAULT_IMAGE_SIZE);
			const quality = params.quality?.trim() || DEFAULT_IMAGE_QUALITY;
			const n = normalizeImageCount(params.n);
			const outputDir = resolveOutputDir(ctx.cwd, params.outputDir);
			const outputFormat = normalizeOutputFormat(params.outputFormat);
			const timeoutMs = normalizeTimeout(params.timeoutMs);
			const baseURL = trimEnv("OPENAI_BASE_URL");
			const requestDetails: OpenAIImageToolDetails["request"] = {
				model,
				size,
				quality,
				n,
				outputDir,
				outputFormat,
				timeoutMs,
				apiKeyEnvVar: envVarName,
				baseURL,
			};

			const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
			const { signal: requestSignal, cleanup } = createTimeoutSignal(timeoutMs, signal);

			onUpdate?.({
				content: [{ type: "text", text: `Generating ${n} image${n === 1 ? "" : "s"} with ${model}...` }],
				details: { request: requestDetails, images: [] },
			});

			try {
				const request = makeGenerateRequest({
					model,
					prompt: params.prompt,
					size,
					quality,
					n,
					outputFormat,
					background: params.background?.trim() || undefined,
					outputCompression: params.outputCompression,
					moderation: params.moderation?.trim() || undefined,
					user: params.user?.trim() || undefined,
				});

				const response = await client.images.generate(request as never, { signal: requestSignal, timeout: timeoutMs } as never);
				const data = Array.isArray(response.data) ? response.data : [];

				if (data.length === 0) {
					throw new Error("OpenAI returned no generated images.");
				}

				await mkdir(outputDir, { recursive: true });
				onUpdate?.({
					content: [{ type: "text", text: `Saving ${data.length} generated image${data.length === 1 ? "" : "s"}...` }],
					details: { request: requestDetails, images: [] },
				});

				const filenamePrefix = sanitizeFilenamePart(params.filenamePrefix, "openai-image");
				const images: GeneratedImageDetails[] = [];

				for (const [index, image] of data.entries()) {
					let bytes: Buffer;
					let mimeType = mimeTypeForFormat(outputFormat);
					let source: GeneratedImageDetails["source"];

					if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
						bytes = decodeBase64Image(image.b64_json);
						source = "base64";
					} else if (typeof image.url === "string" && image.url.length > 0) {
						const downloaded = await fetchImageFromUrl(image.url, requestSignal);
						bytes = downloaded.bytes;
						mimeType = downloaded.mimeType;
						source = "url";
					} else {
						throw new Error(`OpenAI image ${index + 1} did not include b64_json or url data.`);
					}

					const extension = extensionForMimeType(mimeType, outputFormat);
					const outputPath = createOutputPath(outputDir, filenamePrefix, index, extension);

					await withFileMutationQueue(outputPath, async () => {
						await writeFile(outputPath, bytes, { flag: "wx" });
					});

					images.push({
						path: outputPath,
						mimeType,
						bytes: bytes.byteLength,
						source,
						revisedPrompt: typeof image.revised_prompt === "string" ? image.revised_prompt : undefined,
					});
				}

				return {
					content: [{ type: "text", text: formatResultText(images) }],
					details: {
						request: requestDetails,
						images,
					},
				};
			} finally {
				cleanup();
			}
		},
	});
}
