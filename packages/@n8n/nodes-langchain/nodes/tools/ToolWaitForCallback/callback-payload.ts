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
