import type { INodeProperties } from 'n8n-workflow';
import {
	authenticationProperty,
	httpMethodsProperty,
	ignoreBotsOption,
	ipWhitelistOption,
	noResponseBodyOption,
	onlyRunIfOption,
	onReceivedResponseDataOption,
	responseCodeProperty,
	responseHeadersOption,
} from 'n8n-nodes-base/dist/nodes/Webhook/description';

/** Parameter holding the authentication mode, shared with the Webhook node's properties. */
export const AUTH_PROPERTY_NAME = 'callbackAuthentication';

/**
 * What the LLM is told the tool does. Kept as the shared tool description property so the
 * schema generator and the NDV treat it exactly like every other AI tool node.
 *
 * The default states the two things the model cannot infer from the schema: that the call
 * suspends the run, and what that does to the other calls of the same turn. Tool calls of one
 * turn run one after another in the order the model listed them, so a call placed after this
 * one waits for the callback. This text is the whole contract — there is no other channel to
 * the model — and it is the user's to keep when they rewrite the description.
 */
export const toolDescriptionProperty: INodeProperties = {
	displayName: 'Description',
	name: 'toolDescription',
	type: 'string',
	default:
		'Suspend this conversation until an external system calls back about a job. Provide the identifier the external system will report the result under; the callback body is returned as the result of this call. This call suspends the run: when you make several tool calls in one turn, the calls listed before this one run first, and the calls listed after it run only once the callback has arrived. Use a distinct identifier for each job you wait on.',
	required: true,
	typeOptions: { rows: 5 },
	description:
		'Explain to the LLM what this tool does. Keep the note on suspension: tool calls of one turn run in order, so a call placed after this one runs only after the callback arrives.',
};

/**
 * The correlation id the wait is registered under.
 *
 * Left as a plain string parameter on purpose: the NDV already offers the three sources
 * this needs. "Fixed" is the literal value, "Expression" makes it an `=`-prefixed n8n
 * expression, and the model-defined toggle rewrites it to `$fromAI(...)`, which is also
 * what puts it into the tool schema. Nothing else is published to the LLM, because the
 * schema is built by scanning parameters for `$fromAI` calls.
 */
export const waitIdentifierProperty: INodeProperties = {
	displayName: 'Wait Identifier',
	name: 'waitIdentifier',
	type: 'string',
	default: '',
	required: true,
	placeholder: 'e.g. 125',
	description:
		"Identifier this wait is registered under. Use the model-defined toggle when the value only exists inside the conversation (for example an ID returned by an earlier tool call). An expression here resolves against the agent's own input item, not against anything the model produced, so an expression cannot reach earlier tool results.",
};

export const callbackMethodProperty: INodeProperties = {
	...httpMethodsProperty,
	displayName: 'Callback Method',
	description: 'HTTP method the external system will use to deliver the callback',
	default: 'POST',
};

/**
 * The path segment of the callback endpoint, read by the webhook description through
 * `fromParameter('path')` — the same declaration the Webhook node uses.
 *
 * Empty keeps the generated endpoint: `getNodeWebhookPath` returns `path || node.webhookId`
 * for a full-path webhook, so the node's own id is the endpoint until a path is given. That
 * is what every existing node keeps on upgrade.
 *
 * An expression is resolved when the workflow registers its webhooks, against the same
 * limited context as every other webhook path: `$parameter`, `$workflow`, `$vars` and the
 * rest resolve, and anything that needs run data does not exist yet.
 */
export const callbackPathProperty: INodeProperties = {
	displayName: 'Path',
	name: 'path',
	type: 'string',
	default: '',
	placeholder: 'e.g. order-status',
	description:
		"Path the callback endpoint listens on. Leave it empty to keep the endpoint generated for this node. Dynamic segments are written with ':', as in 'orders/:orderId'. An expression here is resolved when the workflow is published, so it cannot read data from a run.",
};

/** Authentication for the callback endpoint, reusing the Webhook node's shared property. */
export const callbackAuthenticationProperty: INodeProperties =
	authenticationProperty(AUTH_PROPERTY_NAME);

/**
 * How the identifier is read out of the incoming request.
 *
 * One expression over the whole request. In the webhook phase the expression engine binds
 * `$json` to the request itself — `body`, `headers`, `query` and `params` — so where the
 * identifier lives is said by the expression alone, with the editor's normal expression
 * tooling and no parser of its own. The runtime reads this single parameter and nothing
 * else, so there is no second field that could disagree with it.
 */
export const callbackIdentifierProperty: INodeProperties = {
	displayName: 'Callback Identifier',
	name: 'callbackIdentifier',
	type: 'string',
	default: '={{ $json.body.id }}',
	required: true,
	placeholder: 'e.g. {{ $json.headers["x-correlation-key"] }}',
	hint: 'Resolved against each incoming callback, where $json is the whole request: $json.body, $json.headers, $json.query and $json.params. The editor preview has no request to show, so it renders no value here.',
	description:
		'Expression that reads the identifier out of the incoming callback. The current item here is the whole request, so its body, headers, query and path parameters are all reachable. The resolved value is compared literally against the Wait Identifier.',
};

/**
 * When the callback endpoint answers.
 *
 * Only "Immediately" is offered, and it is the only mode this endpoint can have. The other
 * modes of the Webhook node answer from a running workflow: `lastNode` and `responseNode`
 * both resolve the `responsePromise` that `WebhookHelpers.executeWebhook` hands to
 * `WorkflowRunner.run`. A callback starts no run — it resumes one that is already parked,
 * possibly on another instance in queue mode — so there is no such promise to resolve and
 * no connection the resumed run could reach. The field states that rather than leaving the
 * response implicit.
 */
export const callbackResponseModeProperty: INodeProperties = {
	displayName: 'Respond',
	name: 'responseMode',
	type: 'options',
	noDataExpression: true,
	options: [
		{
			name: 'Immediately',
			value: 'onReceived',
			description: 'As soon as the callback is authenticated and correlated',
		},
	],
	default: 'onReceived',
	description: 'When and how to respond to the callback',
};

/** The response code of the callback endpoint, shared with the Webhook node. */
export const callbackResponseCodeProperty: INodeProperties = responseCodeProperty;

/**
 * The endpoint's options, every one of them the Webhook node's own property.
 *
 * `Ignore Bots` and `IP(s) Allowlist` gate the request before authentication, through the
 * shared `checkRequestGates`. `Only Run If` runs after it, through the shared
 * `requestMatchesOnlyRunIf`: a callback it rejects resolves no tool call, which matters more
 * here than on a webhook, where the same filter only saves an execution. Response body and
 * headers are read by `getResponseData` and `WebhookResponseHeaders`, so there is no second
 * reading of those fields.
 *
 * The binary options stay out: they put bytes in `binary`, and the `ai_tool` channel carries
 * JSON to a model, which has no representation for them.
 */
export const callbackOptionsProperty: INodeProperties = {
	displayName: 'Options',
	name: 'options',
	type: 'collection',
	placeholder: 'Add option',
	default: {},
	options: [
		ignoreBotsOption,
		ipWhitelistOption,
		onlyRunIfOption,
		noResponseBodyOption,
		onReceivedResponseDataOption,
		responseHeadersOption,
	],
};

export const callbackUrlNotice: INodeProperties = {
	displayName:
		'The callback URL exists as soon as the workflow is published, so an external system can be told about it before any wait is registered. It is the same URL for every run: a callback is matched to a waiting tool call by its Callback Identifier, not by its URL. A callback that arrives before the tool call registers its wait is parked until it does.',
	name: 'callbackUrlNotice',
	type: 'notice',
	default: '',
};
