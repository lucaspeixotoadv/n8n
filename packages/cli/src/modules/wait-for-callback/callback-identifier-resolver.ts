import { Logger } from '@n8n/backend-common';
import { Service } from '@n8n/di';
import { WebhookContext } from 'n8n-core';
import type { INode, IWebhookData, IWorkflowExecuteAdditionalData, Workflow } from 'n8n-workflow';
import { normalizeCallbackCorrelationValue } from 'n8n-workflow';

export type CallbackIdentifierLookup = {
	workflow: Workflow;
	node: INode;
	webhookData: IWebhookData;
	additionalData: IWorkflowExecuteAdditionalData;
};

/** Node parameter holding the expression that reads the identifier out of a callback. */
const CALLBACK_IDENTIFIER_PARAMETER = 'callbackIdentifier';

/**
 * Reads the correlation identifier a tool is configured to match callbacks on.
 *
 * This is ordinary node-parameter resolution in the webhook phase, which is exactly why it
 * is worth isolating: in that phase the expression engine binds `$json` to the whole
 * request — `body`, `headers`, `query` and `params` — so a user writes `{{ $json.body.id }}`
 * with the editor's normal expression tooling and no bespoke request parser exists at all.
 * The correlation layer therefore sees the entire request while the agent only ever
 * receives the body.
 */
@Service()
export class CallbackIdentifierResolver {
	constructor(private readonly logger: Logger) {
		this.logger = this.logger.scoped('waiting-executions');
	}

	/** The normalised identifier, or `null` when the request carries nothing usable. */
	resolve({
		workflow,
		node,
		webhookData,
		additionalData,
	}: CallbackIdentifierLookup): string | null {
		const context = new WebhookContext(
			workflow,
			node,
			additionalData,
			'webhook',
			webhookData,
			[],
			null,
		);

		try {
			return normalizeCallbackCorrelationValue(
				context.getNodeParameter(CALLBACK_IDENTIFIER_PARAMETER, ''),
			);
		} catch (error) {
			// A misconfigured expression must not distinguish itself from a request that
			// simply carries no identifier, so both end at the same non-matching outcome.
			this.logger.debug('Could not resolve the callback identifier of a tool callback', {
				workflowId: workflow.id,
				nodeName: node.name,
				error,
			});
			return null;
		}
	}
}
