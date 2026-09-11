import { rm } from 'node:fs/promises';

import type { IDataObject, INodeExecutionData } from 'n8n-workflow';

/**
 * The body of a callback, in the shape the agent receives it.
 *
 * A JSON object body is handed over as-is. Anything else (a bare string, a number, an
 * array) is wrapped under `body`, so the tool result is always an object — which is what
 * both the run data and the agent's observation builder expect.
 */
export function toCallbackPayload(body: unknown): IDataObject {
	if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
		return body as IDataObject;
	}

	return { body: body ?? null };
}

/** An uploaded part, as the multipart parser writes it to a temporary path. */
type UploadedFile = { filepath?: unknown };

/** Every temporary path the multipart parser wrote for this request. */
function uploadedPaths(files: unknown): string[] {
	if (files === null || typeof files !== 'object') return [];

	const paths: string[] = [];
	for (const entry of Object.values(files as Record<string, unknown>)) {
		for (const file of Array.isArray(entry) ? entry : [entry]) {
			const { filepath } = (file ?? {}) as UploadedFile;
			if (typeof filepath === 'string') paths.push(filepath);
		}
	}

	return paths;
}

/**
 * The fields of a multipart callback, with the files it carried removed from disk.
 *
 * A multipart body is parsed into `{ data, files }`, where every file is already written to
 * a temporary path. The fields become the tool result and the files are dropped: the
 * `ai_tool` channel carries JSON to a model and has no representation for a file, so keeping
 * the fields is what makes such a callback useful instead of a failure.
 *
 * Removing the temporary files is part of reading them. Nothing else on this path removes
 * them, and a callback endpoint can be called as often as an external system likes.
 */
export async function toMultipartCallbackPayload(body: unknown): Promise<IDataObject> {
	if (body === null || typeof body !== 'object') return toCallbackPayload(body);

	const { data, files } = body as { data?: unknown; files?: unknown };

	await Promise.all(
		uploadedPaths(files).map(async (filepath) => {
			// A file that is already gone is not a problem worth failing the callback for.
			await rm(filepath, { force: true }).catch(() => {});
		}),
	);

	return toCallbackPayload(data ?? {});
}

/** The tool result as node output: one item on the tool channel, carrying only the body. */
export function toToolResult(payload: IDataObject): INodeExecutionData[][] {
	return [[{ json: payload }]];
}

/**
 * What the node records as its output while it is parked.
 *
 * The engine discards this task the moment the execution resumes — the parked run is popped
 * and replaced by the real callback body — so it never reaches the model. It exists purely
 * so that opening a waiting (or later cancelled) execution shows what the tool call is
 * actually blocked on, rather than an echo of the arguments the model passed in.
 */
export function toWaitingRecord(correlationValue: string): INodeExecutionData[][] {
	return [
		[
			{
				json: {
					status: 'waitingForCallback',
					waitIdentifier: correlationValue,
				},
			},
		],
	];
}
