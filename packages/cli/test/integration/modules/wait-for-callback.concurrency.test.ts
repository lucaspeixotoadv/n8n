import { createWorkflow, testDb, testModules } from '@n8n/backend-test-utils';
import { Container } from '@n8n/di';
import type express from 'express';
import type {
	IDataObject,
	INode,
	IWebhookData,
	IWorkflowBase,
	IWorkflowExecuteAdditionalData,
	IWorkflowExecutionDataProcess,
	Workflow,
} from 'n8n-workflow';
import { createEmptyRunExecutionData } from 'n8n-workflow';
import { Readable } from 'stream';
import { mock } from 'vitest-mock-extended';

import { ActiveExecutions } from '@/active-executions';
import { ExecutionAlreadyResumingError } from '@/errors/execution-already-resuming.error';
import { ConflictError } from '@/errors/response-errors/conflict.error';
import { rawBodyReader } from '@/middlewares';
import type { CallbackIdentifierResolver } from '@/modules/wait-for-callback/callback-identifier-resolver';
import type { CallbackWaitResumeService } from '@/modules/wait-for-callback/callback-wait-resume.service';
import { CallbackWaitRepository } from '@/modules/wait-for-callback/callback-wait.repository';
import { CallbackWaitService } from '@/modules/wait-for-callback/callback-wait.service';
import { ToolCallbackWebhooks } from '@/modules/wait-for-callback/tool-callback-webhooks';
import { isWebhookStaticResponse } from '@/webhooks/webhook-response';
import type { WebhookService } from '@/webhooks/webhook.service';
import type { WebhookRequest } from '@/webhooks/webhook.types';

import { createExecution } from '../shared/db/executions';

const NAMESPACE = 'endpoint-a';
const KEY = '125';

const claim = {
	executionId: 'exec-1',
	toolCallId: 'call-1',
	nodeId: 'node-1',
	workflowId: 'wf-1',
	userId: 'user-1',
};

/**
 * The invariant under test: for one identifier, at most one delivery consumes the callback
 * and starts the continuation, however many deliveries race for it, from however many
 * processes. Every guard here is a conditional write in the database, so the tests run
 * against a real one and fire their deliveries concurrently.
 */
describe('Wait for Callback resume idempotency', () => {
	let repository: CallbackWaitRepository;
	let service: CallbackWaitService;

	beforeAll(async () => {
		await testModules.loadModules(['wait-for-callback']);
		await testDb.init();
		repository = Container.get(CallbackWaitRepository);
		service = Container.get(CallbackWaitService);
	});

	beforeEach(async () => {
		await repository.delete({});
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	const deliver = async (payload: IDataObject) => await service.correlate(NAMESPACE, KEY, payload);

	const kinds = (outcomes: Array<Awaited<ReturnType<typeof deliver>>>) =>
		outcomes.map((o) => o.kind);

	describe('the correlation claim', () => {
		it('lets exactly one of two simultaneous deliveries claim the wait', async () => {
			await repository.insertWait({}, NAMESPACE, KEY, claim);

			const outcomes = await Promise.all([deliver({ n: 1 }), deliver({ n: 2 })]);

			expect(kinds(outcomes).sort()).toEqual(['claimed', 'duplicate']);
		});

		it('lets exactly one of many concurrent deliveries claim the wait and keeps only its payload', async () => {
			const wait = await repository.insertWait({}, NAMESPACE, KEY, claim);
			const deliveries = Array.from({ length: 12 }, async (_, n) => await deliver({ n }));

			const outcomes = await Promise.all(deliveries);

			const winners = outcomes.filter((o) => o.kind === 'claimed');
			expect(winners).toHaveLength(1);
			expect(outcomes.filter((o) => o.kind === 'duplicate')).toHaveLength(11);

			const [winner] = winners;
			if (winner.kind !== 'claimed') throw new Error('unreachable');
			const row = await repository.findOneByOrFail({ id: wait.id });
			expect(row.status).toBe('resuming');
			expect(row.payload).toEqual(winner.payload);
		});

		it('keeps the winner payload once a later delivery carries a different one', async () => {
			const wait = await repository.insertWait({}, NAMESPACE, KEY, claim);
			await deliver({ result: 'first' });
			await service.markResolved(wait.id);
			const resolved = await repository.findOneByOrFail({ id: wait.id });

			const outcome = await deliver({ result: 'second' });

			expect(outcome.kind).toBe('duplicate');
			expect(await repository.findOneByOrFail({ id: wait.id })).toEqual(resolved);
			expect(await repository.findLive({}, NAMESPACE, KEY)).toBeNull();
		});

		it('parks exactly one of concurrent first deliveries and reports the rest as duplicates', async () => {
			const deliveries = Array.from({ length: 6 }, async (_, n) => await deliver({ n }));

			const outcomes = await Promise.all(deliveries);

			expect(outcomes.filter((o) => o.kind === 'parked')).toHaveLength(1);
			expect(outcomes.filter((o) => o.kind === 'duplicate')).toHaveLength(5);
			expect(await repository.countBy({ namespace: NAMESPACE, correlationValue: KEY })).toBe(1);
		});

		it('resolves a wait registering while its callback arrives in exactly one way', async () => {
			const [registration, delivery] = await Promise.all([
				service.registerWait({
					namespace: NAMESPACE,
					correlationValue: KEY,
					executionId: 'exec-1',
					toolCallId: 'call-1',
					nodeId: 'node-1',
				}),
				deliver({ id: 125 }),
			]);

			// Either the wait got there first and the delivery claimed it, or the delivery got
			// there first and the registration consumed the parked body. Never both, never neither.
			const consistent =
				(registration.status === 'registered' && delivery.kind === 'claimed') ||
				(registration.status === 'resolved' && delivery.kind === 'parked');
			expect(consistent).toBe(true);
			expect(await repository.countBy({ namespace: NAMESPACE, correlationValue: KEY })).toBe(1);
		});
	});

	describe('the execution claim', () => {
		let workflow: IWorkflowBase;

		beforeAll(async () => {
			workflow = await createWorkflow({ nodes: [], connections: {} });
		});

		it('lets exactly one of concurrent resumes take a waiting execution', async () => {
			const execution = await createExecution(
				{ finished: false, waitTill: new Date(), status: 'waiting', mode: 'webhook' },
				workflow,
			);
			const data: IWorkflowExecutionDataProcess = {
				executionMode: 'webhook',
				executionData: createEmptyRunExecutionData(),
				workflowData: workflow,
			};
			const activeExecutions = Container.get(ActiveExecutions);
			const resume = async () =>
				await activeExecutions.add(data, { executionId: execution.id, expectedStatus: 'waiting' });

			const outcomes = await Promise.allSettled(Array.from({ length: 5 }, resume));

			expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
			const losers = outcomes.filter((o) => o.status === 'rejected');
			expect(losers).toHaveLength(4);
			for (const loser of losers) {
				expect(loser.reason).toBeInstanceOf(ExecutionAlreadyResumingError);
			}
		});
	});

	describe('the endpoint', () => {
		const webhookService = mock<WebhookService>();
		const resumeService = mock<CallbackWaitResumeService>();
		const identifierResolver = mock<CallbackIdentifierResolver>();
		let handler: ToolCallbackWebhooks;

		beforeEach(() => {
			vi.clearAllMocks();
			handler = new ToolCallbackWebhooks(
				webhookService,
				Container.get(CallbackWaitService),
				resumeService,
				identifierResolver,
			);
			identifierResolver.resolve.mockReturnValue(KEY);
			resumeService.resume.mockResolvedValue('resumed');
		});

		/** A callback request with `body`, built the way the server hands it to the handler. */
		function callbackRequest(body: IDataObject) {
			const raw = JSON.stringify(body);
			const req = Readable.from([Buffer.from(raw)]) as unknown as WebhookRequest;
			req.headers = { 'content-type': 'application/json' };
			req.query = {} as WebhookRequest['query'];
			void rawBodyReader(req, mock<express.Response>(), vi.fn());

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

			return {
				workflow,
				node: mock<INode>({ id: 'node-1', name: 'Wait', webhookId: NAMESPACE, typeVersion: 1 }),
				webhookData: mock<IWebhookData>({
					webhookDescription: { name: 'default', httpMethod: 'POST', path: '' },
				}),
				additionalData: mock<IWorkflowExecuteAdditionalData>(),
				req,
				res: mock<express.Response>({ status: vi.fn().mockReturnThis(), end: vi.fn() } as never),
			};
		}

		const deliverThroughEndpoint = async (body: IDataObject) => {
			webhookService.runWebhook.mockResolvedValue({ workflowData: [[{ json: body }]] });
			return await handler.handle(callbackRequest(body));
		};

		it('resumes once for many concurrent deliveries and answers the rest with a conflict', async () => {
			const wait = await repository.insertWait({}, NAMESPACE, KEY, claim);
			const deliveries = Array.from(
				{ length: 10 },
				async (_, n) => await deliverThroughEndpoint({ attempt: n }),
			);

			const outcomes = await Promise.allSettled(deliveries);

			const accepted = outcomes.filter((o) => o.status === 'fulfilled');
			expect(accepted).toHaveLength(1);
			const [winner] = accepted;
			if (winner.status !== 'fulfilled' || !isWebhookStaticResponse(winner.value)) {
				throw new Error('The accepted delivery must get the node response');
			}
			expect(winner.value.body).toEqual({ message: 'Callback received' });

			const refused = outcomes.filter((o) => o.status === 'rejected');
			expect(refused).toHaveLength(9);
			for (const loser of refused) expect(loser.reason).toBeInstanceOf(ConflictError);

			// One continuation, fed with the winner's payload and nothing else.
			expect(resumeService.resume).toHaveBeenCalledTimes(1);
			const [, payload] = resumeService.resume.mock.calls[0];
			const row = await repository.findOneByOrFail({ id: wait.id });
			expect(row.status).toBe('completed');
			expect(row.payload).toEqual(payload);
		});

		it('changes nothing for a delivery that arrives after the resume completed', async () => {
			const wait = await repository.insertWait({}, NAMESPACE, KEY, claim);
			await deliverThroughEndpoint({ result: 'first' });
			const resolved = await repository.findOneByOrFail({ id: wait.id });

			await expect(deliverThroughEndpoint({ result: 'second' })).rejects.toThrow(ConflictError);

			expect(resumeService.resume).toHaveBeenCalledTimes(1);
			expect(await repository.findOneByOrFail({ id: wait.id })).toEqual(resolved);
		});

		it('does not resume again for a delivery that arrives while the first resume is in flight', async () => {
			await repository.insertWait({}, NAMESPACE, KEY, claim);
			let finishFirstResume!: () => void;
			resumeService.resume.mockImplementationOnce(
				async () =>
					await new Promise((resolve) => {
						finishFirstResume = () => resolve('resumed');
					}),
			);

			const first = deliverThroughEndpoint({ result: 'first' });
			// Give the first delivery time to take the claim and block inside its resume.
			await new Promise((resolve) => setImmediate(resolve));
			await expect(deliverThroughEndpoint({ result: 'second' })).rejects.toThrow(ConflictError);

			finishFirstResume();
			await first;

			expect(resumeService.resume).toHaveBeenCalledTimes(1);
		});

		it('lets a later delivery retry a resume that never started', async () => {
			await repository.insertWait({}, NAMESPACE, KEY, claim);
			resumeService.resume.mockRejectedValueOnce(new Error('runner unavailable'));

			await expect(deliverThroughEndpoint({ result: 'first' })).rejects.toThrow(
				'runner unavailable',
			);
			await deliverThroughEndpoint({ result: 'second' });

			// The first attempt started nothing, so the second is the first resume, not a second.
			expect(resumeService.resume).toHaveBeenCalledTimes(2);
			const [, payload] = resumeService.resume.mock.calls[1];
			expect(payload).toEqual({ result: 'second' });
			expect(await repository.findLive({}, NAMESPACE, KEY)).toBeNull();
		});
	});
});
