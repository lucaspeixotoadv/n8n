import type { INodeProperties } from 'n8n-workflow';
import {
	authenticationProperty,
	httpMethodsProperty,
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

export const callbackUrlNotice: INodeProperties = {
	displayName:
		"The callback URL is this node's production webhook URL, shown above. It exists as soon as the workflow is published, so an external system can be told about it before any wait is registered. A callback that arrives before the tool call is parked until the wait registers.",
	name: 'callbackUrlNotice',
	type: 'notice',
	default: '',
};
