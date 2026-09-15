import type { IRestApiContext } from '@n8n/rest-api-client';
import { makeRestApiRequest } from '@n8n/rest-api-client';

/**
 * Asks the server to send this session the execution's events, starting with a snapshot.
 * The session is the one the request's `push-ref` header names.
 */
export async function watchExecution(context: IRestApiContext, executionId: string) {
	await makeRestApiRequest(context, 'POST', `/executions/${executionId}/watch`);
}

export async function unwatchExecution(context: IRestApiContext, executionId: string) {
	await makeRestApiRequest(context, 'DELETE', `/executions/${executionId}/watch`);
}
