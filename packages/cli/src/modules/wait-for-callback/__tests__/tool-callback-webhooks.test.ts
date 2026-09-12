import type { CallbackWait } from '../callback-wait.entity';
import type express from 'express';
import type {
	IDataObject,
	INode,
	IWebhookData,
	IWorkflowExecuteAdditionalData,
	Workflow,
} from 'n8n-workflow';
import { normalizeCallbackCorrelationValue } from 'n8n-workflow';
import { Readable } from 'stream';
import { mock } from 'vitest-mock-extended';

import type { CallbackIdentifierResolver } from '../callback-identifier-resolver';
import type { CallbackWaitResumeService } from '../callback-wait-resume.service';
import type { CallbackWaitService } from '../callback-wait.service';
import { ToolCallbackWebhooks } from '../tool-callback-webhooks';
import { rawBodyReader } from '@/middlewares';
import { isWebhookStaticResponse } from '@/webhooks/webhook-response';
import type { WebhookService } from '@/webhooks/webhook.service';
import type { WebhookRequest } from '@/webhooks/webhook.types';

const WEBHOOK_ID = 'endpoint-a';

/** The body of a static webhook response, for asserting what the caller is told. */
function bodyOf(response: Awaited<ReturnType<ToolCallbackWebhooks['handle']>>) {
	if (!isWebhookStaticResponse(response)) throw new Error('Expected a static webhook response');

	return response.body;
}

/**
 * Stands in for the expression engine: reads the node's configured identifier expression
 * against the request envelope the webhook phase exposes as `$json`.
 */
function resolveIdentifier(expression: string, envelope: IDataObject): unknown {
	const match = /^=\{\{\s*\$json\.(\w+)(?:\.(\w+)|\["([^"]+)"\])\s*\}\}$/.exec(expression);
	if (!match) return undefined;

	const [, section, dotKey, bracketKey] = match;
	const part = envelope[section] as IDataObject | undefined;
	return part?.[dotKey ?? bracketKey];
}

/**
 * Builds the request the way the server does: a readable stream carrying the raw bytes,
 * run through `rawBodyReader` so `contentType`, `encoding` and `readRawBody` are the real
 * ones. The webhook routes are registered before the global body parser, so the handler
 * has to parse the body itself; handing it a request whose `body` is already an object
 * would assert nothing about whether it does.
 */
function streamRequest(
	rawBody: string,
	headers: Record<string, string>,
	query: IDataObject,
): WebhookRequest {
	const req = Readable.from([Buffer.from(rawBody)]) as unknown as WebhookRequest;
	req.headers = headers;
	req.query = query as WebhookRequest['query'];
	rawBodyReader(req, mock<express.Response>(), vi.fn());

	return req;
}

describe('ToolCallbackWebhooks', () => {
	const callbackWaitService = mock<CallbackWaitService>();
	const resumeService = mock<CallbackWaitResumeService>();
	const webhookService = mock<WebhookService>();
	const identifierResolver = mock<CallbackIdentifierResolver>();

	let handler: ToolCallbackWebhooks;
	let res: express.Response;

	function buildRequest({
		body = {},
		headers = {},
		query = {},
		identifier = '={{ $json.body.id }}',
	}: {
		body?: IDataObject;
		headers?: Record<string, string>;
		query?: IDataObject;
		identifier?: string;
	}) {
		const envelope: IDataObject = { body, headers, query, params: {} };
		const node = mock<INode>({
			id: 'node-1',
			name: 'Wait for Callback',
			webhookId: WEBHOOK_ID,
			typeVersion: 1,
		});
		// The description defines no response fields, so every read reaches the engine with an
		// undefined value, which the real engine answers with the caller's default.
		const workflow = mock<Workflow>({
			id: 'wf-1',
			expression: mock<Workflow['expression']>({
				getSimpleParameterValue: vi.fn(
					(...args: Parameters<Workflow['expression']['getSimpleParameterValue']>) => args[5],
				),
				getComplexParameterValue: vi.fn(
					(...args: Parameters<Workflow['expression']['getComplexParameterValue']>) => args[5],
				),
			}),
		});

		// The node returns only the body as its output; the envelope stays with the correlator.
		webhookService.runWebhook.mockResolvedValue({ workflowData: [[{ json: body }]] });

		identifierResolver.resolve.mockReturnValue(
			normalizeCallbackCorrelationValue(resolveIdentifier(identifier, envelope)),
		);

		return {
			workflow,
			node,
			// A description with no response fields, so the endpoint answers its defaults.
			webhookData: mock<IWebhookData>({
				webhookDescription: { name: 'default', httpMethod: 'POST', path: '' },
			}),
			additionalData: mock<IWorkflowExecuteAdditionalData>(),
			req: streamRequest(
				JSON.stringify(body),
				{ 'content-type': 'application/json', ...headers },
				query,
			),
			res,
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		res = mock<express.Response>({ status: vi.fn().mockReturnThis(), end: vi.fn() } as never);
		handler = new ToolCallbackWebhooks(
			webhookService,
			callbackWaitService,
			resumeService,
			identifierResolver,
		);
		callbackWaitService.correlate.mockResolvedValue({ kind: 'ignored' });
	});

	it.each([
		['body', '={{ $json.body.id }}', { body: { id: 125 } }],
		['header', '={{ $json.headers["x-request-id"] }}', { headers: { 'x-request-id': '125' } }],
		['query', '={{ $json.query.job_id }}', { query: { job_id: '125' } }],
	])('correlates on an identifier taken from the %s', async (_source, identifier, parts) => {
		await handler.handle(buildRequest({ identifier, ...parts }));

		expect(callbackWaitService.correlate).toHaveBeenCalledWith(
			WEBHOOK_ID,
			'125',
			expect.anything(),
		);
	});

	it('parses a raw body before the node reads it', async () => {
		const request = buildRequest({ body: { id: 125, status: 'DONE' } });

		// What the node's `webhook()` sees: `additionalData.httpRequest` is the request the
		// handler parsed, and `getBodyData()` reads its `body`.
		let bodySeenByNode: unknown;
		webhookService.runWebhook.mockImplementation(async (_workflow, _webhookData, _node, data) => {
			bodySeenByNode = data.httpRequest?.body;
			return { workflowData: [[{ json: { id: 125 } }]] };
		});

		await handler.handle(request);

		expect(bodySeenByNode).toEqual({ id: 125, status: 'DONE' });
	});

	it('leaves the body empty when the request declares no content type', async () => {
		const request = buildRequest({ body: { id: 125 } });
		// A body with no `content-type` is not one of the types a webhook parses, so the
		// raw bytes stay unread and the node gets nothing to correlate on.
		request.req = streamRequest(JSON.stringify({ id: 125 }), {}, {});

		let bodySeenByNode: unknown;
		webhookService.runWebhook.mockImplementation(async (_workflow, _webhookData, _node, data) => {
			bodySeenByNode = data.httpRequest?.body;
			return { workflowData: [[{ json: {} }]] };
		});

		await handler.handle(request);

		expect(bodySeenByNode).toBeUndefined();
	});

	it('normalises a numeric identifier to the same value as its string form', async () => {
		await handler.handle(buildRequest({ body: { id: 125 } }));

		expect(callbackWaitService.correlate).toHaveBeenCalledWith(WEBHOOK_ID, '125', { id: 125 });
	});

	it('gives the agent the body only, never headers or query', async () => {
		callbackWaitService.correlate.mockResolvedValue({
			kind: 'claimed',
			wait: mock<CallbackWait>({ id: 'row-1' }),
			payload: { id: 125 },
		});
		resumeService.resume.mockResolvedValue('resumed');

		await handler.handle(
			buildRequest({
				body: { id: 125, status: 'DONE' },
				headers: { authorization: 'secret', 'x-request-id': '125' },
				query: { trace: 'abc' },
			}),
		);

		const [, payload] = resumeService.resume.mock.calls[0];
		expect(payload).toEqual({ id: 125, status: 'DONE' });
		expect(payload).not.toHaveProperty('headers');
		expect(payload).not.toHaveProperty('query');
	});

	it('answers the same way for a request with no usable identifier', async () => {
		const response = await handler.handle(buildRequest({ body: { unrelated: true } }));

		expect(callbackWaitService.correlate).not.toHaveBeenCalled();
		expect(bodyOf(response)).toEqual({ message: 'Callback received' });
	});

	it('answers the same way for a duplicate delivery', async () => {
		callbackWaitService.correlate.mockResolvedValue({ kind: 'ignored' });

		const response = await handler.handle(buildRequest({ body: { id: 125 } }));

		expect(resumeService.resume).not.toHaveBeenCalled();
		expect(bodyOf(response)).toEqual({ message: 'Callback received' });
	});

	it('answers the same way for a callback that woke an execution', async () => {
		callbackWaitService.correlate.mockResolvedValue({
			kind: 'claimed',
			wait: mock<CallbackWait>({ id: 'row-1' }),
			payload: { id: 125 },
		});
		resumeService.resume.mockResolvedValue('resumed');

		const response = await handler.handle(buildRequest({ body: { id: 125 } }));

		expect(bodyOf(response)).toEqual({ message: 'Callback received' });
	});

	it('stops when the node already answered the request itself', async () => {
		const request = buildRequest({ body: { id: 125 } });
		webhookService.runWebhook.mockResolvedValue({ noWebhookResponse: true });

		await handler.handle(request);

		expect(callbackWaitService.correlate).not.toHaveBeenCalled();
	});

	it('marks a delivered callback as resolved', async () => {
		callbackWaitService.correlate.mockResolvedValue({
			kind: 'claimed',
			wait: mock<CallbackWait>({ id: 'row-1' }),
			payload: { id: 125 },
		});
		resumeService.resume.mockResolvedValue('resumed');

		await handler.handle(buildRequest({ body: { id: 125 } }));

		expect(callbackWaitService.markResolved).toHaveBeenCalledWith('row-1');
	});

	it('keeps the claim when the execution has not parked yet', async () => {
		callbackWaitService.correlate.mockResolvedValue({
			kind: 'claimed',
			wait: mock<CallbackWait>({ id: 'row-1' }),
			payload: { id: 125 },
		});
		resumeService.resume.mockResolvedValue('notParkedYet');

		await handler.handle(buildRequest({ body: { id: 125 } }));

		expect(callbackWaitService.markResolved).not.toHaveBeenCalled();
	});

	it('releases the claim when the resume throws', async () => {
		callbackWaitService.correlate.mockResolvedValue({
			kind: 'claimed',
			wait: mock<CallbackWait>({ id: 'row-1' }),
			payload: { id: 125 },
		});
		resumeService.resume.mockRejectedValue(new Error('runner unavailable'));

		await expect(handler.handle(buildRequest({ body: { id: 125 } }))).rejects.toThrow();
		expect(callbackWaitService.releaseClaim).toHaveBeenCalledWith('row-1');
	});
});
