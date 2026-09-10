import { getConnectionHintNoticeField } from '@n8n/ai-utilities';
import { credentialsProperty } from 'n8n-nodes-base/dist/nodes/Webhook/description';
import { WebhookAuthorizationError } from 'n8n-nodes-base/dist/nodes/Webhook/error';
import { validateWebhookAuthentication } from 'n8n-nodes-base/dist/nodes/Webhook/utils';
import {
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

import { toCallbackPayload, toToolResult } from './callback-payload';
import {
	AUTH_PROPERTY_NAME,
	callbackAuthenticationProperty,
	callbackIdentifierProperties,
	callbackIdentifierSourceProperty,
	callbackMethodProperty,
	callbackUrlNotice,
	toolDescriptionProperty,
	waitIdentifierProperty,
} from './descriptions';

/**
 * The endpoint that receives callbacks for this tool.
 *
 * `isFullPath` with an empty path registers the node's own `webhookId`, so the URL is fixed
 * and exists as soon as the workflow is published — before any execution does. That is what
 * lets an external system be told about it up front, and what makes a callback that beats
 * its tool call addressable at all. `nodeType` marks the endpoint as one that resolves a
 * pending tool call rather than starting a workflow, which is how the router picks its
 * handler without knowing this node type.
 */
const callbackWebhookDescription: IWebhookDescription = {
	name: 'default',
	nodeType: 'toolCallback',
	isFullPath: true,
	...webhookDescriptionFields({
		httpMethod: fromParameter('httpMethod', 'POST'),
	}),
	path: '',
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
		icon: 'fa:hourglass-half',
		iconColor: 'crimson',
		group: ['transform'],
		version: 1,
		description: 'Suspend the agent until an external system calls back',
		defaults: { name: 'Wait for Callback' },
		codex: {
			categories: ['AI'],
			subcategories: { AI: ['Tools'], Tools: ['Other Tools'] },
		},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		outputNames: ['Tool'],
		credentials: credentialsProperty(AUTH_PROPERTY_NAME),
		webhooks: [callbackWebhookDescription],
		properties: [
			getConnectionHintNoticeField([NodeConnectionTypes.AiAgent]),
			toolDescriptionProperty,
			waitIdentifierProperty,
			callbackUrlNotice,
			callbackMethodProperty,
			callbackAuthenticationProperty,
			callbackIdentifierSourceProperty,
			...callbackIdentifierProperties,
		],
	};

	/**
	 * Authenticates the callback and shapes the tool result.
	 *
	 * Returning only the body is the whole point of this method: headers and query stay
	 * available to the correlation layer, which needs them, and never reach the model.
	 */
	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		try {
			await validateWebhookAuthentication(this, AUTH_PROPERTY_NAME);
		} catch (error) {
			if (error instanceof WebhookAuthorizationError) {
				const response = this.getResponseObject();
				response.writeHead(error.responseCode, {
					'WWW-Authenticate': 'Basic realm="Webhook"',
				});
				response.end(error.message);
				return { noWebhookResponse: true };
			}
			throw error;
		}

		return { workflowData: toToolResult(toCallbackPayload(this.getBodyData())) };
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

		return [this.getInputData()];
	}
}

/** The id of the tool call being served, as the engine stamps it onto the node's input. */
function getToolCallId(ctx: IExecuteFunctions): string | undefined {
	const json = ctx.getInputData()[0]?.json as IDataObject | undefined;
	return typeof json?.toolCallId === 'string' ? json.toolCallId : undefined;
}
