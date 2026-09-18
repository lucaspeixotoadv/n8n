import { createWorkflow, testDb, testModules } from '@n8n/backend-test-utils';
import { Container } from '@n8n/di';
import type express from 'express';
import type {
	CallbackWaitRegistration,
	IDataObject,
	INode,
	IWebhookData,
	IWorkflowBase,
	IWorkflowExecuteAdditionalData,
	IWorkflowExecutionDataProcess,
	Workflow,
} from 'n8n-workflow';
import { createEmptyRunExecutionData, normalizeCallbackCorrelationValue } from 'n8n-workflow';
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
import { CallbackWaitCollisionError } from '@/modules/wait-for-callback/errors/callback-wait-collision.error';
import { ToolCallbackWebhooks } from '@/modules/wait-for-callback/tool-callback-webhooks';
import { isWebhookStaticResponse } from '@/webhooks/webhook-response';
import type { WebhookService } from '@/webhooks/webhook.service';
import type { WebhookRequest } from '@/webhooks/webhook.types';

import { createExecution } from '../shared/db/executions';

const NAMESPACE = 'endpoint-a';
const OTHER_NAMESPACE = 'endpoint-b';
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
 * processes — and at most one execution ever waits for it, however many register at once.
 * Every guard here is a conditional write in the database, so the tests run against a real
 * one and fire their registrations and deliveries concurrently.
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

	// The endpoint, with the resume replaced: what is under test is which delivery gets to
	// start it and with what, not the runner.
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
	function callbackRequest(body: IDataObject, namespace = NAMESPACE) {
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
			node: mock<INode>({ id: 'node-1', name: 'Wait', webhookId: namespace, typeVersion: 1 }),
			webhookData: mock<IWebhookData>({
				webhookDescription: { name: 'default', httpMethod: 'POST', path: '' },
			}),
			additionalData: mock<IWorkflowExecuteAdditionalData>(),
			req,
			res: mock<express.Response>({ status: vi.fn().mockReturnThis(), end: vi.fn() } as never),
		};
	}

	const deliverThroughEndpoint = async (body: IDataObject, namespace = NAMESPACE) => {
		webhookService.runWebhook.mockResolvedValue({ workflowData: [[{ json: body }]] });
		return await handler.handle(callbackRequest(body, namespace));
	};

	/** The executions the endpoint started a resume for, in order. */
	const resumedExecutions = () => resumeService.resume.mock.calls.map(([wait]) => wait.executionId);

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

	/**
	 * Several executions asking to wait for one key. The partial unique index on the live
	 * key admits one row, so the election happens at registration: the registration the
	 * database commits first holds the key, every later one fails before it parks, and the
	 * one callback for the key can only ever reach the holder.
	 */
	describe('one key, many executions', () => {
		const register = async (
			executionId: string,
			overrides: Partial<CallbackWaitRegistration> = {},
		) =>
			await service.registerWait({
				namespace: NAMESPACE,
				correlationValue: KEY,
				executionId,
				toolCallId: `call-${executionId}`,
				nodeId: 'node-1',
				...overrides,
			});

		/** Races the registrations of `executionIds` and sorts the winners from the losers. */
		const race = async (executionIds: string[]) => {
			const outcomes = await Promise.allSettled(executionIds.map(async (id) => await register(id)));

			return {
				winners: outcomes.filter((o) => o.status === 'fulfilled'),
				losers: outcomes
					.filter((o) => o.status === 'rejected')
					.map((o) => o.reason as unknown)
					.map((reason) => {
						if (!(reason instanceof CallbackWaitCollisionError)) throw reason;
						return reason;
					}),
			};
		};

		it('resumes the one execution waiting for the key on the one callback for it', async () => {
			await register('exec-1');

			await deliverThroughEndpoint({ result: 'done' });

			expect(resumedExecutions()).toEqual(['exec-1']);
			const [, payload] = resumeService.resume.mock.calls[0];
			expect(payload).toEqual({ result: 'done' });
			expect(await repository.findLive({}, NAMESPACE, KEY)).toBeNull();
		});

		it('resumes it once when two identical callbacks arrive at the same time', async () => {
			await register('exec-1');

			const outcomes = await Promise.allSettled([
				deliverThroughEndpoint({ attempt: 1 }),
				deliverThroughEndpoint({ attempt: 2 }),
			]);

			expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
			const refused = outcomes.filter((o) => o.status === 'rejected');
			expect(refused).toHaveLength(1);
			expect(refused[0].reason).toBeInstanceOf(ConflictError);
			expect(resumedExecutions()).toEqual(['exec-1']);
		});

		it('lets exactly one of two executions racing for the key hold it, and gives it the callback', async () => {
			const { winners, losers } = await race(['exec-1', 'exec-2']);

			expect(winners).toHaveLength(1);
			expect(losers).toHaveLength(1);
			const holder = await repository.findLive({}, NAMESPACE, KEY);
			expect(holder?.status).toBe('waiting');

			await deliverThroughEndpoint({ result: 'done' });

			expect(resumedExecutions()).toEqual([holder?.executionId]);
		});

		it('elects one holder among many executions racing for the key', async () => {
			const executionIds = Array.from({ length: 6 }, (_, n) => `exec-${n}`);

			const { winners, losers } = await race(executionIds);

			expect(winners).toHaveLength(1);
			expect(losers).toHaveLength(5);
			const holder = await repository.findLive({}, NAMESPACE, KEY);
			expect(executionIds).toContain(holder?.executionId);

			await deliverThroughEndpoint({ result: 'done' });

			expect(resumedExecutions()).toEqual([holder?.executionId]);
		});

		it('holds the key for the execution that registered first, however many come after', async () => {
			await register('exec-1');
			const first = await repository.findLive({}, NAMESPACE, KEY);

			await expect(register('exec-2')).rejects.toMatchObject({
				holder: { executionId: 'exec-1', since: first?.createdAt },
			});
			await expect(register('exec-3')).rejects.toMatchObject({
				holder: { executionId: 'exec-1', since: first?.createdAt },
			});
			await deliverThroughEndpoint({ result: 'done' });

			expect(resumedExecutions()).toEqual(['exec-1']);
		});

		it('ends every losing registration with a collision that names the holder and its wait', async () => {
			const { losers } = await race(['exec-1', 'exec-2', 'exec-3']);
			const holder = await repository.findLive({}, NAMESPACE, KEY);
			if (!holder) throw new Error('One registration must hold the key');

			expect(losers).toHaveLength(2);
			for (const loser of losers) {
				expect(loser).toBeInstanceOf(CallbackWaitCollisionError);
				expect(loser.correlationValue).toBe(KEY);
				expect(loser.holder).toEqual({ executionId: holder.executionId, since: holder.createdAt });
				expect(loser.message).toContain(`execution ${holder.executionId} has held this identifier`);
			}
		});

		it('leaves no losing execution with a wait: only the holder has a row', async () => {
			const executionIds = ['exec-1', 'exec-2', 'exec-3', 'exec-4'];

			await race(executionIds);

			const rows = await repository.findBy({ namespace: NAMESPACE, correlationValue: KEY });
			expect(rows).toHaveLength(1);
			expect(rows[0].status).toBe('waiting');
			for (const executionId of executionIds.filter((id) => id !== rows[0].executionId)) {
				expect(await repository.findBy({ executionId })).toEqual([]);
			}
		});

		it('elects a single holder whatever timestamps the racing rows would carry', async () => {
			// Registrations fired in one tick land within the same millisecond, which is the
			// resolution of `createdAt`. The election never reads it: the committed insert holds
			// the key, so equal timestamps leave nothing to break, in every round.
			for (let round = 0; round < 5; round++) {
				await repository.delete({});
				const executionIds = Array.from({ length: 4 }, (_, n) => `exec-${round}-${n}`);

				const { winners, losers } = await race(executionIds);

				expect(winners).toHaveLength(1);
				const holder = await repository.findLive({}, NAMESPACE, KEY);
				expect(new Set(losers.map((loser) => loser.holder?.executionId))).toEqual(
					new Set([holder?.executionId]),
				);
			}
		});

		it('keeps one holder and at most one consumed callback when registrations and deliveries race', async () => {
			const [registrations, deliveries] = await Promise.all([
				Promise.allSettled([register('exec-1'), register('exec-2')]),
				Promise.all([deliver({ n: 1 }), deliver({ n: 2 })]),
			]);

			const winners = registrations.filter((o) => o.status === 'fulfilled');
			expect(winners).toHaveLength(1);
			const losers = registrations.filter((o) => o.status === 'rejected');
			expect(losers).toHaveLength(1);
			expect(losers[0].reason).toBeInstanceOf(CallbackWaitCollisionError);

			// The holder either registered and one delivery claimed its wait, or consumed a
			// body one delivery parked. The other delivery is a duplicate either way.
			const winner = winners[0].status === 'fulfilled' ? winners[0].value : undefined;
			const claimed = deliveries.filter((o) => o.kind === 'claimed').length;
			const parked = deliveries.filter((o) => o.kind === 'parked').length;
			expect(deliveries.filter((o) => o.kind === 'duplicate')).toHaveLength(1);
			expect(
				(winner?.status === 'registered' && claimed === 1 && parked === 0) ||
					(winner?.status === 'resolved' && claimed === 0 && parked === 1),
			).toBe(true);
			expect(await repository.countBy({ namespace: NAMESPACE, correlationValue: KEY })).toBe(1);
		});

		it('lets a callback that arrived first be consumed by exactly one of the executions racing for it', async () => {
			const payload = { id: 125, status: 'DONE' };
			expect((await deliver(payload)).kind).toBe('parked');

			const outcomes = await Promise.allSettled([register('exec-1'), register('exec-2')]);

			// Exactly one registration gets the parked body, and its row names it as the consumer.
			const consumers = outcomes.filter(
				(o) => o.status === 'fulfilled' && o.value.status === 'resolved',
			);
			expect(consumers).toHaveLength(1);
			if (consumers[0].status !== 'fulfilled') throw new Error('unreachable');
			expect(consumers[0].value).toEqual({ status: 'resolved', payload });
			const consumed = await repository.findOneByOrFail({
				namespace: NAMESPACE,
				correlationValue: KEY,
				status: 'completed',
			});
			expect(consumed.executionId).not.toBeNull();

			// The other saw the key either still parked, and collides with the consumer, or
			// already released by the consumption, and registers a fresh wait for the next
			// callback — exactly what it would get had it come a moment later. Never the body.
			const [other] = outcomes.filter((o) => o !== consumers[0]);
			if (other.status === 'rejected') {
				expect(other.reason).toBeInstanceOf(CallbackWaitCollisionError);
				expect((other.reason as CallbackWaitCollisionError).holder?.executionId).toBe(
					consumed.executionId,
				);
				expect(await repository.findLive({}, NAMESPACE, KEY)).toBeNull();
			} else {
				expect(other.value).toEqual({ status: 'registered' });
				expect(await repository.findLive({}, NAMESPACE, KEY)).toMatchObject({
					status: 'waiting',
					payload: null,
				});
			}
			expect(consumed.payload).toEqual(payload);
		});

		it('keeps the same key on two endpoints apart', async () => {
			await register('exec-1');
			await register('exec-2', { namespace: OTHER_NAMESPACE });

			await deliverThroughEndpoint({ result: 'done' });

			expect(resumedExecutions()).toEqual(['exec-1']);
			expect(await repository.findLive({}, OTHER_NAMESPACE, KEY)).toMatchObject({
				executionId: 'exec-2',
				status: 'waiting',
			});
		});

		it('collides identifiers that normalise to the same key, and resumes on either form', async () => {
			await register('exec-1', { correlationValue: normalizeCallbackCorrelationValue(125) ?? '' });

			await expect(
				register('exec-2', { correlationValue: normalizeCallbackCorrelationValue(' 125 ') ?? '' }),
			).rejects.toMatchObject({ holder: { executionId: 'exec-1' } });

			identifierResolver.resolve.mockReturnValue(normalizeCallbackCorrelationValue(125));
			await deliverThroughEndpoint({ id: 125 });

			expect(resumedExecutions()).toEqual(['exec-1']);
		});
	});
});
