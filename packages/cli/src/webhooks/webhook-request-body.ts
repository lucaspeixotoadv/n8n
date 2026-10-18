import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';

import { parseBody } from '@/middlewares';
import { createMultiFormDataParser } from '@/webhooks/webhook-form-data';
import type { WebhookRequest } from '@/webhooks/webhook.types';

const { formDataFileSizeMax } = Container.get(GlobalConfig).endpoints;
const parseFormData = createMultiFormDataParser(formDataFileSizeMax);

/** The content types a webhook node above version 1 parses. */
function isParsableContentType(contentType: string | undefined): boolean {
	if (!contentType) return false;

	return (
		contentType.startsWith('application/json') ||
		contentType.startsWith('text/plain') ||
		contentType.startsWith('application/x-www-form-urlencoded') ||
		contentType.endsWith('/xml') ||
		contentType.endsWith('+xml')
	);
}

/**
 * Parses the body of a webhook request in place, by its content type.
 *
 * The webhook routes are registered before the global body parser on purpose, so that a node
 * can take the request stream itself. Every endpoint that reads a body therefore parses it
 * here, and an endpoint that skips this step sees no body at all.
 *
 * A multipart body becomes `{ data, files }`, where each file is already written to a
 * temporary path. The returned cleanup removes those files: the caller runs it once the
 * request, or the response stream that reads them, is done. `nodeVersion` carries the Webhook
 * node's own history: version 1 parses whatever arrives, later versions parse only the content
 * types they declare.
 */
export async function parseWebhookRequestBody(
	req: WebhookRequest,
	nodeVersion: number,
): Promise<(() => Promise<void>) | undefined> {
	const { contentType } = req;

	if (contentType === 'multipart/form-data') {
		const { body, cleanup } = await parseFormData(req);
		req.body = body;
		return cleanup;
	}

	if (nodeVersion > 1 && !isParsableContentType(contentType)) return undefined;

	await parseBody(req);

	return undefined;
}
