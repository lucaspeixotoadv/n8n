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

/** The tool result as node output: one item on the tool channel, carrying only the body. */
export function toToolResult(payload: IDataObject): INodeExecutionData[][] {
	return [[{ json: payload }]];
}
