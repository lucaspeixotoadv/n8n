import type { Logger } from '@n8n/backend-common';
import type express from 'express';
import type {
	IConnections,
	INode,
	INodeType,
	INodeTypes,
	IWebhookData,
	IWorkflowExecuteAdditionalData,
} from 'n8n-workflow';
import { NodeConnectionTypes, Workflow } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { CallbackIdentifierResolver } from '../callback-identifier-resolver';

const NODE_TYPE = '@n8n/n8n-nodes-langchain.toolWaitForCallback';

const nodeType: INodeType = {
	description: {
		name: 'toolWaitForCallback',
		displayName: 'Wait for Callback',
		version: 1,
		group: ['transform'],
		description: '',
		defaults: {},
		inputs: [],
		outputs: [NodeConnectionTypes.AiTool],
		properties: [
			{
				displayName: 'Callback Identifier',
				name: 'callbackIdentifier',
				type: 'string',
				default: '',
			},
		],
	},
};

const nodeTypes = mock<INodeTypes>({
	getByName: () => nodeType,
	getByNameAndVersion: () => nodeType,
});

/**
 * Resolves the identifier the way the runtime does: a real workflow, a real webhook
 * context, and the request reaching the expression engine through `additionalData`.
 */
async function resolve(callbackIdentifier: string, request: object): Promise<string | null> {
	const node: INode = {
		id: 'node-1',
		name: 'Wait for Callback',
		type: NODE_TYPE,
		typeVersion: 1,
		position: [0, 0],
		webhookId: 'endpoint-a',
		parameters: { callbackIdentifier },
	};

	const workflow = new Workflow({
		id: 'wf-1',
		nodes: [node],
		connections: {} as IConnections,
		active: false,
		nodeTypes,
	});

	const additionalData = mock<IWorkflowExecuteAdditionalData>({
		httpRequest: request as express.Request,
		httpResponse: mock<express.Response>(),
	});

	const resolver = new CallbackIdentifierResolver(
		mock<Logger>({ scoped: () => mock<Logger>() }) as unknown as Logger,
	);

	// The webhook layer acquires the expression isolate around this call, as `LiveWebhooks`
	// does for any node whose webhook phase can evaluate expressions.
	await workflow.expression.acquireIsolate();
	try {
		return resolver.resolve({
			workflow,
			node: workflow.nodes[node.name],
			webhookData: mock<IWebhookData>(),
			additionalData,
		});
	} finally {
		await workflow.expression.releaseIsolate();
	}
}

describe('CallbackIdentifierResolver', () => {
	const request = {
		body: { id: 125, status: 'DONE' },
		headers: { 'x-request-id': '125', authorization: 'secret' },
		query: { job_id: '125' },
		params: {},
	};

	it.each([
		['body', '={{ $json.body.id }}'],
		['header', '={{ $json.headers["x-request-id"] }}'],
		['query', '={{ $json.query.job_id }}'],
	])('reads the identifier from the %s of the request', async (_source, expression) => {
		expect(await resolve(expression, request)).toBe('125');
	});

	it('normalises a numeric identifier to the same value as its string form', async () => {
		expect(await resolve('={{ $json.body.id }}', request)).toBe(
			await resolve('={{ $json.headers["x-request-id"] }}', request),
		);
	});

	it('returns nothing for a request that carries no identifier', async () => {
		expect(
			await resolve('={{ $json.body.id }}', { body: {}, headers: {}, query: {}, params: {} }),
		).toBe(null);
	});

	it('returns nothing rather than an object when the expression points at a container', async () => {
		expect(await resolve('={{ $json.body }}', request)).toBe(null);
	});

	it('accepts a fixed identifier with no expression at all', async () => {
		expect(await resolve('static-key', request)).toBe('static-key');
	});
});
