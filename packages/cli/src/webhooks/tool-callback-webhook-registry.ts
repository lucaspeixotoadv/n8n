import { Service } from '@n8n/di';
import type express from 'express';
import type { INode, IWebhookData, IWorkflowExecuteAdditionalData, Workflow } from 'n8n-workflow';

import { WebhookNotFoundError } from '@/errors/response-errors/webhook-not-found.error';

import type { WebhookResponse } from './webhook-response';
import type { IWebhookResponseCallbackData, WebhookRequest } from './webhook.types';

export type ToolCallbackRequest = {
	workflow: Workflow;
	node: INode;
	webhookData: IWebhookData;
	additionalData: IWorkflowExecuteAdditionalData;
	req: WebhookRequest;
	res: express.Response;
};

/** What the webhook router needs of whoever resolves tool callbacks. */
export type ToolCallbackHandler = {
	handle(request: ToolCallbackRequest): Promise<IWebhookResponseCallbackData | WebhookResponse>;
};

/**
 * The seam between the production webhook router and the feature that resolves tool
 * callbacks.
 *
 * A tool-callback endpoint is registered and routed like any other node webhook, but it
 * resumes a suspended tool call instead of starting a workflow. The router only needs to
 * know that such a handler may exist, which keeps the routing layer free of any knowledge
 * of the tool node or its persistence, and lets the feature ship as a module that can be
 * turned off.
 */
@Service()
export class ToolCallbackWebhookRegistry {
	private handler?: ToolCallbackHandler;

	register(handler: ToolCallbackHandler) {
		this.handler = handler;
	}

	async handle(
		request: ToolCallbackRequest,
	): Promise<IWebhookResponseCallbackData | WebhookResponse> {
		if (!this.handler) {
			// Nothing can resolve this endpoint, so it is indistinguishable from one that was
			// never registered.
			throw new WebhookNotFoundError(
				{ path: request.req.params.path, httpMethod: request.req.method },
				{ hint: 'production' },
			);
		}

		return await this.handler.handle(request);
	}
}
