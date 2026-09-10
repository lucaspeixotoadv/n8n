import { Service } from '@n8n/di';
import type express from 'express';
import type { IDataObject } from 'n8n-workflow';

import { CallbackIdentifierResolver } from './callback-identifier-resolver';
import { CallbackWaitResumeService } from './callback-wait-resume.service';
import { CallbackWaitService } from './callback-wait.service';
import type {
	ToolCallbackHandler,
	ToolCallbackRequest,
} from '@/webhooks/tool-callback-webhook-registry';
import { sanitizeWebhookRequest } from '@/webhooks/webhook-request-sanitizer';
import { WebhookService } from '@/webhooks/webhook.service';
import type { IWebhookResponseCallbackData } from '@/webhooks/webhook.types';

/**
 * Serves the endpoint of a Wait for Callback tool.
 *
 * Unlike every other production webhook, this one never starts a workflow. It authenticates
 * the request through the node itself, correlates it with a parked tool call, and hands the
 * resume to the runner.
 *
 * Every authenticated request gets the same empty `200`, whether it woke an execution, was
 * a duplicate, or matched nothing at all. Answering differently would turn the endpoint
 * into an oracle for which identifiers are currently being waited on.
 */
@Service()
export class ToolCallbackWebhooks implements ToolCallbackHandler {
	constructor(
		private readonly webhookService: WebhookService,
		private readonly callbackWaitService: CallbackWaitService,
		private readonly resumeService: CallbackWaitResumeService,
		private readonly identifierResolver: CallbackIdentifierResolver,
	) {}

	async handle(request: ToolCallbackRequest): Promise<IWebhookResponseCallbackData> {
		const { workflow, node, webhookData, additionalData, req, res } = request;

		// The namespace is the webhook registration that received this request, which for the
		// tool's full-path registration is the node's own `webhookId`. Without one the request
		// could not have been routed here at all.
		const namespace = node.webhookId;
		if (!namespace) return this.acknowledge(res);

		sanitizeWebhookRequest(req);
		additionalData.httpRequest = req;
		additionalData.httpResponse = res;

		// The node owns authentication and decides what counts as the callback body. A node
		// that answered the request itself (an auth failure) leaves nothing to correlate.
		const webhookResult = await this.webhookService.runWebhook(
			workflow,
			webhookData,
			node,
			additionalData,
			'webhook',
			null,
		);
		if (webhookResult.noWebhookResponse === true) return { noWebhookResponse: true };

		const correlationValue = this.identifierResolver.resolve(request);
		if (correlationValue === null) return this.acknowledge(res);

		const payload = (webhookResult.workflowData?.[0]?.[0]?.json ?? {}) as IDataObject;
		const outcome = await this.callbackWaitService.correlate(namespace, correlationValue, payload);

		if (outcome.kind !== 'claimed') return this.acknowledge(res);

		await this.deliver(outcome.wait, payload);

		return this.acknowledge(res);
	}

	/**
	 * Runs the resume the correlation claimed.
	 *
	 * A resume that cannot run yet keeps its claim: the execution registered the wait only
	 * moments ago and has not been persisted as waiting, so the hand-off that fires when it
	 * parks completes the delivery. Anything else releases the correlation key.
	 */
	private async deliver(
		wait: Parameters<CallbackWaitResumeService['resume']>[0],
		payload: IDataObject,
	): Promise<void> {
		let outcome;
		try {
			outcome = await this.resumeService.resume(wait, payload);
		} catch (error) {
			// Give the claim back so a later delivery, or the deferred hand-off, can retry.
			await this.callbackWaitService.releaseClaim(wait.id);
			throw error;
		}

		if (outcome === 'notParkedYet') return;

		await this.callbackWaitService.markResolved(wait.id);
	}

	private acknowledge(res: express.Response): IWebhookResponseCallbackData {
		res.status(200).end();
		return { noWebhookResponse: true };
	}
}
