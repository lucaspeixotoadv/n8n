import type express from 'express';
import { mock } from 'vitest-mock-extended';

import { WebhookNotFoundError } from '@/errors/response-errors/webhook-not-found.error';
import {
	ToolCallbackWebhookRegistry,
	type ToolCallbackHandler,
	type ToolCallbackRequest,
} from '@/webhooks/tool-callback-webhook-registry';
import type { WebhookRequest } from '@/webhooks/webhook.types';

const request = mock<ToolCallbackRequest>({
	req: mock<WebhookRequest>({ method: 'POST', params: { path: 'endpoint-a' } } as never),
	res: mock<express.Response>(),
});

describe('ToolCallbackWebhookRegistry', () => {
	it('routes to the registered handler', async () => {
		const registry = new ToolCallbackWebhookRegistry();
		const handler = mock<ToolCallbackHandler>();
		handler.handle.mockResolvedValue({ noWebhookResponse: true });

		registry.register(handler);
		await registry.handle(request);

		expect(handler.handle).toHaveBeenCalledWith(request);
	});

	it('reports an unknown webhook when nothing can resolve tool callbacks', async () => {
		await expect(new ToolCallbackWebhookRegistry().handle(request)).rejects.toThrow(
			WebhookNotFoundError,
		);
	});
});
