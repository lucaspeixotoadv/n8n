import { GlobalConfig } from '@n8n/config';
import { Container } from '@n8n/di';

import { parseBody } from '@/middlewares';
import { createMultiFormDataParser } from '@/webhooks/webhook-form-data';
import type { WebhookRequest } from '@/webhooks/webhook.types';

const { formDataFileSizeMax } = Container.get(GlobalConfig).endpoints;
const parseFormData = createMultiFormDataParser(formDataFileSizeMax);

/** The content types a webhook node above version 1 parses. */
const isDeclaredContentType = (contentType?: string) =>
	contentType?.startsWith('application/json') === true ||
	contentType?.startsWith('text/plain') === true ||
	contentType?.startsWith('application/x-www-form-urlencoded') === true ||
	contentType?.endsWith('/xml') === true ||
	contentType?.endsWith('+xml') === true;

/**
 * Parses the body of a webhook request in place, by its content type.
 *
 * The webhook routes are registered before the global body parser on purpose, so that a node
 * can take the request stream itself. Every endpoint that reads a body therefore parses it
 * here, and an endpoint that skips this step sees no body at all.
 *
 * A multipart body becomes `{ data, files }`, where each file is already written to a
 * temporary path that its reader must remove. `nodeVersion` carries the Webhook node's own
 * history: version 1 parses whatever arrives, later versions parse only the content types
 * they declare.
 */
export async function parseWebhookRequestBody(req: WebhookRequest, nodeVersion: number) {
	const { contentType } = req;

	if (contentType === 'multipart/form-data') {
		req.body = await parseFormData(req);
		return;
	}

	if (nodeVersion > 1 && !isDeclaredContentType(contentType)) return;

	await parseBody(req);
}
