import type { INodeProperties } from 'n8n-workflow';
import {
	authenticationProperty,
	httpMethodsProperty,
	ignoreBotsOption,
	ipWhitelistOption,
	noResponseBodyOption,
	onReceivedResponseDataOption,
	responseCodeProperty,
	responseHeadersOption,
} from 'n8n-nodes-base/dist/nodes/Webhook/description';

/** Parameter holding the authentication mode, shared with the Webhook node's properties. */
export const AUTH_PROPERTY_NAME = 'callbackAuthentication';

/**
 * What the LLM is told the tool does. Kept as the shared tool description property so the
 * schema generator and the NDV treat it exactly like every other AI tool node.
 */
export const toolDescriptionProperty: INodeProperties = {
	displayName: 'Description',
	name: 'toolDescription',
	type: 'string',
	default:
		'Suspend this conversation until an external system calls back about a job. Provide the identifier the external system will report the result under.',
	required: true,
	typeOptions: { rows: 3 },
	description:
		'Explain to the LLM what this tool does. A specific description makes the model call it at the right moment.',
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

export const callbackIdentifierSourceProperty: INodeProperties = {
	displayName: 'Callback Identifier Source',
	name: 'callbackIdentifierSource',
	type: 'options',
	noDataExpression: true,
	default: 'body',
	options: [
		{ name: 'Body', value: 'body' },
		{ name: 'Header', value: 'headers' },
		{ name: 'Query', value: 'query' },
	],
	description:
		'Which part of the incoming request carries the identifier. This only picks the default expression below; the value itself is always resolved as one expression over the whole request.',
};

/**
 * How the identifier is read out of the incoming request.
 *
 * Three declarations of one parameter, so each source starts from a correct expression and
 * the runtime still has a single read. In the webhook phase the expression engine binds
 * `$json` to the whole request (`body`, `headers`, `query`, `params`), so this is ordinary
 * n8n expression resolution rather than a parser of its own.
 */
const callbackIdentifierBase: Omit<INodeProperties, 'displayOptions'> = {
	displayName: 'Callback Identifier',
	name: 'callbackIdentifier',
	type: 'string',
	default: '',
	required: true,
	description:
		'Expression that reads the identifier out of the incoming callback. The current item here is the whole request, so its body, headers and query are all reachable — see this field default for the exact form. The resolved value is compared literally against the Wait Identifier.',
};

export const callbackIdentifierProperties: INodeProperties[] = [
	{
		...callbackIdentifierBase,
		default: '={{ $json.body.id }}',
		displayOptions: { show: { callbackIdentifierSource: ['body'] } },
	},
	{
		...callbackIdentifierBase,
		default: '={{ $json.headers["x-request-id"] }}',
		displayOptions: { show: { callbackIdentifierSource: ['headers'] } },
	},
	{
		...callbackIdentifierBase,
		default: '={{ $json.query.id }}',
		displayOptions: { show: { callbackIdentifierSource: ['query'] } },
	},
] as INodeProperties[];

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
 * shared `checkRequestGates`. Response body and headers are read by `getResponseData` and
 * `WebhookResponseHeaders`, so there is no second reading of those fields.
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
