import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
const MAX_HTTP_TIMEOUT_MS = 120_000;
const HTTP_BODY_SAMPLE_BYTES = DEFAULT_MAX_BYTES;

type HttpRequestToolDetails = {
	request: {
		url: string;
		method: string;
		timeoutMs: number;
	};
	response: {
		url: string;
		status: number;
		statusText: string;
		ok: boolean;
		headers: Record<string, string>;
		contentType: string;
		bodyBytes: number;
		bodyTruncated: boolean;
		textBody: boolean;
	};
};

const httpRequestSchema = Type.Object({
	url: Type.String({ description: "HTTP or HTTPS URL to request." }),
	method: Type.Optional(Type.String({ description: "HTTP method. Defaults to GET." })),
	headers: Type.Optional(
		Type.Record(Type.String(), Type.String(), {
			description: "Request headers as name/value strings. Do not include secrets unless the user explicitly provided them.",
		}),
	),
	body: Type.Optional(Type.String({ description: "Optional UTF-8 request body. Not allowed for GET or HEAD." })),
	timeoutMs: Type.Optional(
		Type.Number({
			description: `Request timeout in milliseconds. Defaults to ${DEFAULT_HTTP_TIMEOUT_MS}. Maximum ${MAX_HTTP_TIMEOUT_MS}.`,
			minimum: 1,
			maximum: MAX_HTTP_TIMEOUT_MS,
		}),
	),
});

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
	if (typeof timer === "object" && timer && "unref" in timer) {
		(timer as { unref?: () => void }).unref?.();
	}
}

function normalizeHttpUrl(rawUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl);
	} catch (error) {
		throw new Error(`Invalid URL: ${error instanceof Error ? error.message : String(error)}`);
	}

	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error("http_request only supports http:// and https:// URLs.");
	}

	return parsed.toString();
}

function normalizeHttpMethod(method?: string): string {
	const normalized = (method ?? "GET").trim().toUpperCase();
	if (!/^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/.test(normalized)) {
		throw new Error(`Invalid HTTP method: ${method}`);
	}
	return normalized;
}

function normalizeHttpTimeout(timeoutMs?: number): number {
	if (timeoutMs === undefined) return DEFAULT_HTTP_TIMEOUT_MS;
	if (!Number.isFinite(timeoutMs)) return DEFAULT_HTTP_TIMEOUT_MS;
	return Math.min(Math.max(Math.round(timeoutMs), 1), MAX_HTTP_TIMEOUT_MS);
}

function headersToObject(headers: Headers): Record<string, string> {
	const result: Record<string, string> = {};
	headers.forEach((value, key) => {
		result[key] = value;
	});
	return result;
}

function isTextLikeContentType(contentType: string): boolean {
	const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	return (
		mediaType === "" ||
		mediaType.startsWith("text/") ||
		mediaType.includes("json") ||
		mediaType.includes("xml") ||
		mediaType.includes("javascript") ||
		mediaType === "application/x-www-form-urlencoded"
	);
}

function joinChunks(chunks: Uint8Array[], byteLength: number): Uint8Array {
	const output = new Uint8Array(byteLength);
	let offset = 0;

	for (const chunk of chunks) {
		const remaining = byteLength - offset;
		if (remaining <= 0) break;
		const part = chunk.byteLength > remaining ? chunk.slice(0, remaining) : chunk;
		output.set(part, offset);
		offset += part.byteLength;
	}

	return output;
}

async function readBodySample(response: Response): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!response.body) {
		return { bytes: new Uint8Array(), truncated: false };
	}

	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	const readLimit = HTTP_BODY_SAMPLE_BYTES + 1;
	let bytesRead = 0;

	try {
		while (bytesRead < readLimit) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;

			const remaining = readLimit - bytesRead;
			const chunk = value.byteLength > remaining ? value.slice(0, remaining) : value;
			chunks.push(chunk);
			bytesRead += chunk.byteLength;

			if (value.byteLength > remaining) break;
		}

		if (bytesRead >= readLimit) {
			await reader.cancel().catch(() => {});
		}
	} finally {
		reader.releaseLock();
	}

	const truncated = bytesRead > HTTP_BODY_SAMPLE_BYTES;
	const outputBytes = Math.min(bytesRead, HTTP_BODY_SAMPLE_BYTES);
	return { bytes: joinChunks(chunks, outputBytes), truncated };
}

function formatHttpResponseText(input: {
	method: string;
	url: string;
	status: number;
	statusText: string;
	headers: Record<string, string>;
	bodyBytes: number;
	bodyTruncated: boolean;
	textBody: boolean;
	bodyText: string;
}): string {
	const headerLines = Object.entries(input.headers)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, value]) => `${key}: ${value}`);

	const lines = [
		`${input.method} ${input.url}`,
		`Status: ${input.status} ${input.statusText}`,
		"",
		"Response headers:",
		...(headerLines.length > 0 ? headerLines : ["(none)"]),
		"",
	];

	if (!input.textBody) {
		lines.push(
			`Body: [non-text response omitted; sampled ${formatSize(input.bodyBytes)}${input.bodyTruncated ? ", truncated" : ""}]`,
		);
		return lines.join("\n");
	}

	const body = truncateHead(input.bodyText, {
		maxLines: DEFAULT_MAX_LINES,
		// The stream reader already caps bytes. Use a larger byte limit here so
		// one-line JSON responses are not hidden by line-safe byte truncation.
		maxBytes: HTTP_BODY_SAMPLE_BYTES * 2,
	});

	lines.push("Body:", body.content);

	if (input.bodyTruncated || body.truncated) {
		const reasons = [
			input.bodyTruncated ? `${formatSize(HTTP_BODY_SAMPLE_BYTES)} body sample limit` : undefined,
			body.truncated ? `${DEFAULT_MAX_LINES} line display limit` : undefined,
		].filter(Boolean);
		lines.push("", `[Body truncated: ${reasons.join(" and ")}.]`);
	}

	return lines.join("\n");
}

export function registerHttpRequestTool(pi: ExtensionAPI): void {
	pi.registerTool<typeof httpRequestSchema, HttpRequestToolDetails>({
		name: "http_request",
		label: "HTTP Request",
		description: "Make an HTTP or HTTPS request from the local Node.js runtime and return status, response headers, and a bounded response body sample.",
		promptSnippet: "Make HTTP/HTTPS requests for APIs, webhooks, local dev servers, and service diagnostics.",
		promptGuidelines: [
			"Use http_request instead of ad-hoc curl, wget, or Node scripts when the task requires an HTTP/API request.",
			"Do not send credentials, tokens, or private data with http_request unless the user explicitly provided or requested them.",
		],
		parameters: httpRequestSchema,
		async execute(_toolCallId, params, signal) {
			const url = normalizeHttpUrl(params.url);
			const method = normalizeHttpMethod(params.method);
			const timeoutMs = normalizeHttpTimeout(params.timeoutMs);
			const headers = params.headers ?? {};

			if ((method === "GET" || method === "HEAD") && params.body !== undefined) {
				throw new Error(`${method} requests cannot include a body.`);
			}

			const timeoutController = new AbortController();
			const timeout = setTimeout(() => timeoutController.abort(new Error(`HTTP request timed out after ${timeoutMs}ms`)), timeoutMs);
			unrefTimer(timeout);

			const abortFromAgent = () => timeoutController.abort(signal?.reason);
			if (signal?.aborted) {
				abortFromAgent();
			} else {
				signal?.addEventListener("abort", abortFromAgent, { once: true });
			}

			try {
				const response = await fetch(url, {
					method,
					headers,
					body: params.body,
					redirect: "follow",
					signal: timeoutController.signal,
				});

				const responseHeaders = headersToObject(response.headers);
				const contentType = response.headers.get("content-type") ?? "";
				const textBody = isTextLikeContentType(contentType);
				const bodySample = await readBodySample(response);
				const bodyText = textBody ? new TextDecoder().decode(bodySample.bytes) : "";

				const contentText = formatHttpResponseText({
					method,
					url,
					status: response.status,
					statusText: response.statusText,
					headers: responseHeaders,
					bodyBytes: bodySample.bytes.byteLength,
					bodyTruncated: bodySample.truncated,
					textBody,
					bodyText,
				});

				return {
					content: [{ type: "text", text: contentText }],
					details: {
						request: { url, method, timeoutMs },
						response: {
							url: response.url,
							status: response.status,
							statusText: response.statusText,
							ok: response.ok,
							headers: responseHeaders,
							contentType,
							bodyBytes: bodySample.bytes.byteLength,
							bodyTruncated: bodySample.truncated,
							textBody,
						},
					},
				};
			} finally {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abortFromAgent);
			}
		},
	});
}
