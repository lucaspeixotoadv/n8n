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
import { mock } from 'vitest-mock-extended';

import type { CallbackIdentifierResolver } from '../callback-identifier-resolver';
import type { CallbackWaitResumeService } from '../callback-wait-resume.service';
import type { CallbackWaitService } from '../callback-wait.service';
import { ToolCallbackWebhooks } from '../tool-callback-webhooks';
import type { WebhookService } from '@/webhooks/webhook.service';
import type { WebhookRequest } from '@/webhooks/webhook.types';

const WEBHOOK_ID = 'endpoint-a';

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
		headers?: IDataObject;
		query?: IDataObject;
		identifier?: string;
	}) {
		const envelope: IDataObject = { body, headers, query, params: {} };
		const node = mock<INode>({ id: 'node-1', name: 'Wait for Callback', webhookId: WEBHOOK_ID });
		const workflow = mock<Workflow>({ id: 'wf-1' });

		// The node returns only the body as its output; the envelope stays with the correlator.
		webhookService.runWebhook.mockResolvedValue({ workflowData: [[{ json: body }]] });

		identifierResolver.resolve.mockReturnValue(
			normalizeCallbackCorrelationValue(resolveIdentifier(identifier, envelope)),
		);

		return {
			workflow,
			node,
			webhookData: mock<IWebhookData>(),
			additionalData: mock<IWorkflowExecuteAdditionalData>(),
			req: mock<WebhookRequest>({ body, headers, query } as never),
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
		await handler.handle(buildRequest({ body: { unrelated: true } }));

		expect(callbackWaitService.correlate).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
	});

	it('answers the same way for a duplicate delivery', async () => {
		callbackWaitService.correlate.mockResolvedValue({ kind: 'ignored' });

		await handler.handle(buildRequest({ body: { id: 125 } }));

		expect(resumeService.resume).not.toHaveBeenCalled();
		expect(res.status).toHaveBeenCalledWith(200);
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
