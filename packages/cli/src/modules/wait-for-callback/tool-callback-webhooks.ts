import { Service } from '@n8n/di';
import type { IDataObject, IWebhookResponseData } from 'n8n-workflow';

import { CallbackIdentifierResolver } from './callback-identifier-resolver';
import { CallbackWaitResumeService } from './callback-wait-resume.service';
import { CallbackWaitService } from './callback-wait.service';
import type {
	ToolCallbackHandler,
	ToolCallbackRequest,
} from '@/webhooks/tool-callback-webhook-registry';
import { WebhookExecutionContext } from '@/webhooks/webhook-execution-context';
import { extractWebhookOnReceivedResponse } from '@/webhooks/webhook-on-received-response-extractor';
import { sanitizeWebhookRequest } from '@/webhooks/webhook-request-sanitizer';
import type { WebhookResponse } from '@/webhooks/webhook-response';
import { createNoResponse, createStaticResponse } from '@/webhooks/webhook-response';
import { WebhookService } from '@/webhooks/webhook.service';

/**
 * The node's `webhook()` returns the tool result, never a response body, so the response
 * settings alone decide what the caller sees.
 */
const NO_WEBHOOK_RESULT: IWebhookResponseData = {};

/** What the endpoint answers when the node configured no body of its own. */
const DEFAULT_BODY = { message: 'Callback received' };

/**
 * Serves the endpoint of a Wait for Callback tool.
 *
 * Unlike every other production webhook, this one never starts a workflow. It authenticates
 * the request through the node itself, correlates it with a parked tool call, and hands the
 * resume to the runner.
 *
 * Every authenticated request gets the same response — the one the node configured —
 * whether it woke an execution, was a duplicate, or matched nothing at all. Answering
 * differently would turn the endpoint into an oracle for which identifiers are currently
 * being waited on.
 */
@Service()
export class ToolCallbackWebhooks implements ToolCallbackHandler {
	constructor(
		private readonly webhookService: WebhookService,
		private readonly callbackWaitService: CallbackWaitService,
		private readonly resumeService: CallbackWaitResumeService,
		private readonly identifierResolver: CallbackIdentifierResolver,
	) {}

	async handle(request: ToolCallbackRequest): Promise<WebhookResponse> {
		const { workflow, node, webhookData, additionalData, req, res } = request;

		// The namespace is the webhook registration that received this request, which for the
		// tool's full-path registration is the node's own `webhookId`. Without one the request
		// could not have been routed here at all.
		const namespace = node.webhookId;
		if (!namespace) return this.acknowledge(request);

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
		if (webhookResult.noWebhookResponse === true) return createNoResponse();

		const correlationValue = this.identifierResolver.resolve(request);
		if (correlationValue === null) return this.acknowledge(request);

		const payload = (webhookResult.workflowData?.[0]?.[0]?.json ?? {}) as IDataObject;
		const outcome = await this.callbackWaitService.correlate(namespace, correlationValue, payload);

		if (outcome.kind !== 'claimed') return this.acknowledge(request);

		await this.deliver(outcome.wait, payload);

		return this.acknowledge(request);
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

	/**
	 * The response the node configured, built the same way a webhook that answers on receipt
	 * builds its own: the node's `responseCode`, `responseData` and `responseHeaders`, read
	 * through {@link WebhookExecutionContext} and the shared extractor.
	 *
	 * Every authenticated request gets this same response, whatever the correlation did with
	 * it, so the reply stays what the node declares rather than a report of the outcome. The
	 * expression context carries no execution keys for the same reason.
	 */
	private acknowledge({ workflow, node, webhookData }: ToolCallbackRequest): WebhookResponse {
		const context = new WebhookExecutionContext(workflow, node, webhookData, 'webhook', {});

		const responseCode = context.evaluateSimpleWebhookDescriptionExpression<number>(
			'responseCode',
			undefined,
			200,
		);
		const responseData =
			context.evaluateComplexWebhookDescriptionExpression<string>('responseData');
		const body = extractWebhookOnReceivedResponse(responseData, NO_WEBHOOK_RESULT, DEFAULT_BODY);

		return createStaticResponse(body, responseCode, context.evaluateResponseHeaders());
	}
}
