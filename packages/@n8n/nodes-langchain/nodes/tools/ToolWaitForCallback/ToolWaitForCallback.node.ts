import { getConnectionHintNoticeField } from '@n8n/ai-utilities';
import { credentialsProperty } from 'n8n-nodes-base/dist/nodes/Webhook/description';
import { WebhookAuthorizationError } from 'n8n-nodes-base/dist/nodes/Webhook/error';
import {
	checkRequestGates,
	getResponseCode,
	getResponseData,
	requestMatchesOnlyRunIf,
	validateWebhookAuthentication,
	type RequestGateOptions,
} from 'n8n-nodes-base/dist/nodes/Webhook/utils';
import {
	fromFunction,
	fromParameter,
	MAX_CALLBACK_CORRELATION_LENGTH,
	NodeConnectionTypes,
	normalizeCallbackCorrelationValue,
	NodeOperationError,
	WAIT_INDEFINITELY,
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	type INodeType,
	type INodeTypeDescription,
	type IWebhookFunctions,
	type IWebhookDescription,
	type IWebhookResponseData,
	webhookDescriptionFields,
} from 'n8n-workflow';

import {
	toCallbackPayload,
	toMultipartCallbackPayload,
	toToolResult,
	toWaitingRecord,
} from './callback-payload';
import {
	AUTH_PROPERTY_NAME,
	callbackAuthenticationProperty,
	callbackIdentifierProperties,
	callbackIdentifierSourceProperty,
	callbackMethodProperty,
	callbackOptionsProperty,
	callbackPathProperty,
	callbackResponseCodeProperty,
	callbackResponseModeProperty,
	callbackUrlNotice,
	toolDescriptionProperty,
	waitIdentifierProperty,
} from './descriptions';

/**
 * The endpoint that receives callbacks for this tool.
 *
 * Declared exactly like the Webhook node's own endpoint: `isFullPath` with the `path`
 * parameter, which `getNodeWebhookPath` reads as `path || node.webhookId`. An empty path
 * therefore registers the node's own id, and a path given by the user replaces it. Either
 * way the URL is registered when the workflow is published — before any execution — which
 * is what lets an external system be told about it up front, and what makes a callback that
 * beats its tool call addressable at all.
 *
 * `nodeType` marks the endpoint as one that resolves a pending tool call rather than
 * starting a workflow, which is how the router picks its handler without knowing this node
 * type. It says nothing about the path: routing to this handler and matching the request
 * are separate steps, and correlation keys on the node's `webhookId`, never on the path.
 */
const callbackWebhookDescription: IWebhookDescription = {
	name: 'default',
	nodeType: 'toolCallback',
	isFullPath: true,
	// The URL belongs to the callback block, not above the node's own subject: the NDV
	// shows it after the wait identifier, where the endpoint settings start.
	ndvUrlAfterParameter: 'waitIdentifier',
	...webhookDescriptionFields({
		httpMethod: fromParameter('httpMethod', 'POST'),
		path: fromParameter('path'),
		// The response fields the Webhook node declares for an endpoint that answers on
		// receipt, read by the same resolvers. `ToolCallbackWebhooks` builds the reply from
		// them, so the response is the node's to configure rather than the handler's to fix.
		responseMode: fromParameter('responseMode', 'onReceived'),
		responseCode: fromFunction(getResponseCode),
		responseData: fromFunction(getResponseData),
		responseHeaders: fromParameter(['options', 'responseHeaders']),
	}),
};

/**
 * An AI tool call that resolves on an external HTTP callback instead of returning at once.
 *
 * The node has two halves that never share state directly:
 *
 * - `execute()` runs as an agent tool call. It registers a wait under
 *   `(endpoint, identifier)` and parks the whole execution. The tool call stays pending;
 *   the model gets nothing back until the callback lands.
 * - `webhook()` runs when a callback reaches the node's production URL. It authenticates
 *   the request and returns the body, and only the body, as the node's output. Everything
 *   about correlating that request with a parked wait, and about resuming the execution,
 *   belongs to the runtime rather than to this node.
 */
export class ToolWaitForCallback implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Wait for Callback',
		name: 'toolWaitForCallback',
		icon: 'node:wait',
		iconColor: 'crimson',
		group: ['transform'],
		version: 1,
		// Also what the model reads when the tool description is left empty: the suspension and
		// what it does to the other tool calls of a turn are the contract, not a detail.
		description:
			'Suspend the agent until an external system calls back. Tool calls made after this one in the same turn run only once the callback has arrived.',
		waitingNodeTooltip:
			"Waiting for a callback on this node's URL. The execution resumes when a request arrives whose Callback Identifier matches the Wait Identifier this tool call registered — see the node's output for the identifier it is waiting on.",
		defaults: { name: 'Wait for Callback' },
		codex: {
			categories: ['AI'],
			subcategories: { AI: ['Tools'], Tools: ['Recommended Tools'] },
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		// The endpoint is served by the production webhook router, which reads the node's
		// access control options, so `Allowed Origins (CORS)` is injected into `options` and
		// honoured here exactly as it is on the Webhook node.
		supportsCORS: true,
		credentials: credentialsProperty(AUTH_PROPERTY_NAME),
		webhooks: [callbackWebhookDescription],
		// What the tool is comes first, then the endpoint that resolves it: the URL panel
		// renders after `waitIdentifier`, so everything below it configures the callback.
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiAgent]),
			toolDescriptionProperty,
			waitIdentifierProperty,
			callbackMethodProperty,
			callbackPathProperty,
			callbackAuthenticationProperty,
			callbackResponseModeProperty,
			callbackResponseCodeProperty,
			callbackIdentifierSourceProperty,
			...callbackIdentifierProperties,
			callbackOptionsProperty,
			callbackUrlNotice,
		],
	};

	/**
	 * Gates the callback, authenticates it, and shapes the tool result.
	 *
	 * Returning only the body is the whole point of this method: headers and query stay
	 * available to the correlation layer, which needs them, and never reach the model.
	 */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const options = this.getNodeParameter('options', {}) as RequestGateOptions;
		const request = this.getRequestObject();

		// One refusal for every gate and for wrong credentials alike, so a caller learns
		// that it was refused and never which check refused it.
		const refuse = (error: WebhookAuthorizationError): IWebhookResponseData => {
			const response = this.getResponseObject();
			response.writeHead(error.responseCode, { 'WWW-Authenticate': 'Basic realm="Webhook"' });
			response.end(error.message);
			return { noWebhookResponse: true };
		};

		// The shared order every endpoint keeps: address, then user agent, then credentials.
		if (checkRequestGates(request, options) !== null) {
			return refuse(new WebhookAuthorizationError(403));
		}

		try {
			await validateWebhookAuthentication(this, AUTH_PROPERTY_NAME);
		} catch (error) {
			if (error instanceof WebhookAuthorizationError) return refuse(error);
			throw error;
		}

		// After authentication, so an unauthenticated caller cannot probe the filter. Returning
		// no `workflowData` is what tells the handler that this callback resolves nothing; the
		// caller still gets the response every authenticated request gets.
		if (!requestMatchesOnlyRunIf(this)) return {};

		const body = this.getBodyData();
		const payload =
			request.contentType === 'multipart/form-data'
				? await toMultipartCallbackPayload(body)
				: toCallbackPayload(body);

		return { workflowData: toToolResult(payload) };
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const node = this.getNode();
		const registerCallbackWait = this.helpers.registerCallbackWait;

		// The capability is granted only where a wait can actually park the execution: the
		// workflow engine's own node execution. Agent versions before 3 call their tools
		// in-process, where setting a wait would suspend nothing, and the helper is absent
		// there — so its absence is the check, rather than a guess at the caller's shape.
		if (!registerCallbackWait) {
			throw new NodeOperationError(
				node,
				'This tool call cannot register a callback wait, so it could never be resumed',
				{
					description:
						'Wait for Callback needs an AI Agent that runs tools through the workflow engine (AI Agent version 3 or later).',
				},
			);
		}

		// Suspending in the middle of a tool call batch only works under the requested
		// execution order. The legacy order enqueues the batch the other way round and resumes
		// the agent before its tools have run, so a wait registered there could never hand its
		// result back. An unset order is the legacy one, which is how the engine reads it too.
		if (this.getWorkflowSettings().executionOrder !== 'v1') {
			throw new NodeOperationError(
				node,
				'This tool needs the workflow execution logic "v1 (recommended)"',
				{
					description:
						'Wait for Callback suspends the run in the middle of a tool call batch, which the legacy execution logic "v0" does not support. Open the workflow settings and set "Execution Logic" to "v1 (recommended)".',
				},
			);
		}

		// The registration is keyed by the endpoint that will receive the callback, which
		// is this node's own webhook registration.
		if (!node.webhookId) {
			throw new NodeOperationError(node, 'This node has no callback endpoint registered');
		}

		const executionId = this.getExecutionId();
		if (!executionId) {
			throw new NodeOperationError(node, 'Cannot register a callback wait outside an execution');
		}

		const rawIdentifier = this.getNodeParameter('waitIdentifier', 0, '');
		const correlationValue = normalizeCallbackCorrelationValue(rawIdentifier);
		if (correlationValue === null) {
			throw new NodeOperationError(node, 'The wait identifier is empty or not a usable value', {
				description: `Provide a non-empty scalar identifier of at most ${MAX_CALLBACK_CORRELATION_LENGTH} characters that the external system will report back.`,
			});
		}

		const result = await registerCallbackWait({
			namespace: node.webhookId,
			correlationValue,
			executionId,
			toolCallId: getToolCallId(this),
			nodeId: node.id,
			workflowId: this.getWorkflow().id,
		});

		// The callback had already arrived, so there is nothing to wait for: the tool call
		// completes in place and the execution never parks.
		if (result.status === 'resolved') {
			return toToolResult(result.payload);
		}

		// No deadline: a callback is the only thing that resolves this wait, and inventing a
		// timeout would silently turn a slow external system into a wrong tool result.
		await this.putExecutionToWait(WAIT_INDEFINITELY);

		return toWaitingRecord(correlationValue);
	}
}

/** The id of the tool call being served, as the engine stamps it onto the node's input. */
function getToolCallId(ctx: IExecuteFunctions): string | undefined {
	const json = ctx.getInputData()[0]?.json as IDataObject | undefined;
	return typeof json?.toolCallId === 'string' ? json.toolCallId : undefined;
}
