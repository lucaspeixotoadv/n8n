import { Service } from '@n8n/di';
import type { IDataObject, IWebhookResponseData } from 'n8n-workflow';

import { CallbackIdentifierResolver } from './callback-identifier-resolver';
import { CallbackWaitResumeService } from './callback-wait-resume.service';
import type { CallbackDropReason } from './callback-wait.service';
import { CallbackWaitService } from './callback-wait.service';
import { BadRequestError } from '@/errors/response-errors/bad-request.error';
import { ConflictError } from '@/errors/response-errors/conflict.error';
import { ContentTooLargeError } from '@/errors/response-errors/content-too-large.error';
import { GoneError } from '@/errors/response-errors/gone.error';
import { TooManyRequestsError } from '@/errors/response-errors/too-many-requests.error';
import type {
	ToolCallbackHandler,
	ToolCallbackRequest,
} from '@/webhooks/tool-callback-webhook-registry';
import { WebhookExecutionContext } from '@/webhooks/webhook-execution-context';
import { extractWebhookOnReceivedResponse } from '@/webhooks/webhook-on-received-response-extractor';
import { parseWebhookRequestBody } from '@/webhooks/webhook-request-body';
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
 * The response tells an authenticated caller what its delivery did, the way the waiting
 * webhooks report on theirs:
 *
 * - the node's configured response: the callback was accepted. It resumed the tool call, or
 *   it is parked for the wait that registers its identifier;
 * - `400`: the request carries no identifier the tool could correlate on;
 * - `409`: the identifier was already consumed. An earlier delivery resumed the tool call
 *   and this one changed nothing — not the payload the agent got, not the execution;
 * - `410`: the callback matched its wait, but the execution it belongs to is gone;
 * - `413` / `429`: nothing was waiting and the body could not be parked.
 *
 * A caller that authenticates can therefore learn whether an identifier is live. That is
 * the price of a response a caller can act on, and the node's own gates (credentials, IP
 * allowlist) are what keep the endpoint from being probed.
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

		// The webhook routes are registered before the global body parser, so an endpoint that
		// does not parse the request sees no body at all. A callback never reaches the parsing
		// that `WebhookHelpers.executeWebhook` does, because it is dispatched before it.
		await parseWebhookRequestBody(req, node.typeVersion);

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

		// No `workflowData` means the node declined this callback — its `Only Run If` did not
		// match — so there is nothing to correlate and nothing to resume. Without this the
		// absent data would read as an empty body and wake the tool call with it.
		if (webhookResult.workflowData === undefined) return this.acknowledge(request);

		const correlationValue = this.identifierResolver.resolve(request);
		if (correlationValue === null) {
			throw new BadRequestError(
				'The request carries no callback identifier',
				undefined,
				'The identifier expression of the Wait for Callback tool resolved to nothing for this request.',
			);
		}

		const payload = webhookResult.workflowData[0]?.[0]?.json ?? {};
		const outcome = await this.callbackWaitService.correlate(namespace, correlationValue, payload);

		switch (outcome.kind) {
			case 'claimed':
				await this.deliver(outcome.wait, payload, correlationValue);
				return this.acknowledge(request);
			case 'parked':
				return this.acknowledge(request);
			case 'duplicate':
				throw new ConflictError(
					`The callback with identifier "${correlationValue}" was already received`,
					'Each identifier is consumed once. The first delivery resumed the tool call; this one changed nothing.',
				);
			case 'dropped':
				throw this.dropError(outcome.reason, correlationValue);
		}
	}

	/**
	 * Runs the resume the correlation claimed.
	 *
	 * A resume that cannot run yet keeps its claim: the execution registered the wait only
	 * moments ago and has not been persisted as waiting, so the hand-off that fires when it
	 * parks completes the delivery. A resume that finds no execution left consumes the
	 * identifier all the same — a retry of the same delivery must not park it for a future
	 * wait — and tells the caller so.
	 *
	 * A resume that throws never started the continuation: the runner's own claim on the
	 * execution is the last step that can throw, and it fails the execution itself past that
	 * point. So the claim is handed back for a later delivery to retry, which is a retry of
	 * the resume, never a second one.
	 */
	private async deliver(
		wait: Parameters<CallbackWaitResumeService['resume']>[0],
		payload: IDataObject,
		correlationValue: string,
	): Promise<void> {
		let outcome;
		try {
			outcome = await this.resumeService.resume(wait, payload);
		} catch (error) {
			await this.callbackWaitService.releaseClaim(wait.id);
			throw error;
		}

		if (outcome === 'notParkedYet') return;

		await this.callbackWaitService.markResolved(wait.id);

		if (outcome === 'abandoned') {
			throw new GoneError(
				`The execution waiting for the callback with identifier "${correlationValue}" is no longer running`,
				'The callback matched its wait, but the execution ended or moved on before it arrived. Nothing was resumed.',
			);
		}
	}

	private dropError(reason: CallbackDropReason, correlationValue: string) {
		switch (reason) {
			case 'tooManyParked':
				return new TooManyRequestsError(
					`The callback with identifier "${correlationValue}" could not be kept: nothing is waiting for it and the endpoint holds too many early callbacks`,
					'Deliver the callback again once a tool call waits for this identifier.',
				);
			case 'bodyTooLarge':
				return new ContentTooLargeError(
					`The callback with identifier "${correlationValue}" could not be kept: nothing is waiting for it and its body is too large to park`,
					'Deliver the callback again once a tool call waits for this identifier, or reduce its body.',
				);
		}
	}

	/**
	 * The response the node configured, built the same way a webhook that answers on receipt
	 * builds its own: the node's `responseCode`, `responseData` and `responseHeaders`, read
	 * through {@link WebhookExecutionContext} and the shared extractor.
	 *
	 * This is the answer of an accepted callback, and of a callback the node's own filter
	 * declined. The expression context carries no execution keys: the response is what the
	 * node declares, not a view into the run.
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
