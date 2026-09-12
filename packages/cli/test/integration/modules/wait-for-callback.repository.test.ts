import { testDb, testModules } from '@n8n/backend-test-utils';
import { TransactionRunner } from '@n8n/db';
import { Container } from '@n8n/di';

import { CallbackWaitRepository } from '@/modules/wait-for-callback/callback-wait.repository';

const NAMESPACE = 'endpoint-a';
const OTHER_NAMESPACE = 'endpoint-b';

const claim = {
	executionId: 'exec-1',
	toolCallId: 'call-1',
	nodeId: 'node-1',
	workflowId: 'wf-1',
};

describe('CallbackWaitRepository', () => {
	let repository: CallbackWaitRepository;
	let txRunner: TransactionRunner;

	beforeAll(async () => {
		await testModules.loadModules(['wait-for-callback']);
		await testDb.init();
		repository = Container.get(CallbackWaitRepository);
		txRunner = Container.get(TransactionRunner);
	});

	beforeEach(async () => {
		// The table belongs to a module, so it is not part of the shared truncate list.
		await repository.delete({});
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	describe('the live-key invariant', () => {
		it('rejects a second live wait on the same key', async () => {
			await repository.insertWait({}, NAMESPACE, '125', claim);

			await expect(
				repository.insertWait({}, NAMESPACE, '125', { ...claim, executionId: 'exec-2' }),
			).rejects.toThrow();
		});

		it('rejects a callback parked under a key a wait already holds', async () => {
			await repository.insertWait({}, NAMESPACE, '125', claim);

			await expect(
				repository.insertEarlyCallback({}, NAMESPACE, '125', {
					payload: { id: 125 },
					payloadReceivedAt: new Date(),
				}),
			).rejects.toThrow();
		});

		it('keeps the same correlation value on two endpoints apart', async () => {
			await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.insertWait({}, OTHER_NAMESPACE, '125', { ...claim, nodeId: 'node-2' });

			expect(await repository.findLive({}, NAMESPACE, '125')).toMatchObject({ nodeId: 'node-1' });
			expect(await repository.findLive({}, OTHER_NAMESPACE, '125')).toMatchObject({
				nodeId: 'node-2',
			});
		});

		it('lets a new wait take a key once the previous one resolved', async () => {
			const first = await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.markCompleted({}, first.id);

			const second = await repository.insertWait({}, NAMESPACE, '125', {
				...claim,
				executionId: 'exec-2',
			});

			expect(second.id).not.toBe(first.id);
			expect(await repository.findLive({}, NAMESPACE, '125')).toMatchObject({
				executionId: 'exec-2',
			});
		});

		it('does not let a new wait consume the residue of a resolved correlation', async () => {
			const parked = await repository.insertEarlyCallback({}, NAMESPACE, '125', {
				payload: { id: 125, status: 'FIRST' },
				payloadReceivedAt: new Date(),
			});
			await repository.claimEarlyCallback({}, parked.id, claim);

			// The resolved row stays under the key so a late duplicate is recognisable, but a
			// fresh wait must not pick its payload up.
			await repository.insertWait({}, NAMESPACE, '125', { ...claim, executionId: 'exec-2' });

			expect(await repository.findLive({}, NAMESPACE, '125')).toMatchObject({
				status: 'waiting',
				payload: null,
			});
		});
	});

	describe('the resume claim', () => {
		it('lets exactly one caller move a wait to resuming', async () => {
			const wait = await repository.insertWait({}, NAMESPACE, '125', claim);
			const record = { payload: { id: 125 }, payloadReceivedAt: new Date() };

			expect(await repository.claimForResume({}, wait.id, record)).toBe(true);
			expect(await repository.claimForResume({}, wait.id, record)).toBe(false);
		});

		it('lets exactly one caller consume a parked callback', async () => {
			const parked = await repository.insertEarlyCallback({}, NAMESPACE, '125', {
				payload: { id: 125 },
				payloadReceivedAt: new Date(),
			});

			expect(await repository.claimEarlyCallback({}, parked.id, claim)).toBe(true);
			expect(await repository.claimEarlyCallback({}, parked.id, claim)).toBe(false);
		});

		it('hands a claim back when the resume could not run', async () => {
			const wait = await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.claimForResume({}, wait.id, {
				payload: { id: 125 },
				payloadReceivedAt: new Date(),
			});

			await repository.releaseResumeClaim({}, wait.id);

			expect(await repository.findLive({}, NAMESPACE, '125')).toMatchObject({ status: 'waiting' });
		});

		it('reports the rows of an execution whose payload landed before it parked', async () => {
			const wait = await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.claimForResume({}, wait.id, {
				payload: { id: 125 },
				payloadReceivedAt: new Date(),
			});

			const undelivered = await repository.findUndeliveredForExecution({}, 'exec-1');

			expect(undelivered).toHaveLength(1);
			expect(undelivered[0].payload).toEqual({ id: 125 });
		});
	});

	describe('retention', () => {
		const HOUR = 60 * 60 * 1000;

		it('drops resolved rows past their window but keeps live ones', async () => {
			const resolved = await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.markCompleted({}, resolved.id);
			await repository.insertWait({}, NAMESPACE, '126', { ...claim, executionId: 'exec-2' });

			const removed = await repository.pruneOlderThan({}, new Date(Date.now() + 1000), new Date(0));

			expect(removed).toBe(1);
			expect(await repository.findLive({}, NAMESPACE, '126')).not.toBeNull();
		});

		it('measures a resolved row from when it resolved, not from when its wait began', async () => {
			// Registered well before the window, resolved just now: the wait was simply parked
			// for a long time, and its duplicate guard has to start counting from the resume.
			const wait = await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.update({ id: wait.id }, { createdAt: new Date(Date.now() - 100 * HOUR) });
			await repository.markCompleted({}, wait.id);

			const removed = await repository.pruneOlderThan(
				{},
				new Date(Date.now() - 72 * HOUR),
				new Date(0),
			);

			expect(removed).toBe(0);
			expect(await repository.findLatest({}, NAMESPACE, '125')).toMatchObject({
				status: 'completed',
			});
		});

		it('drops a resolved row once its resolution is past the window', async () => {
			const wait = await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.markCompleted({}, wait.id);
			await repository.update({ id: wait.id }, { resolvedAt: new Date(Date.now() - 73 * HOUR) });

			const removed = await repository.pruneOlderThan(
				{},
				new Date(Date.now() - 72 * HOUR),
				new Date(0),
			);

			expect(removed).toBe(1);
			expect(await repository.findLatest({}, NAMESPACE, '125')).toBeNull();
		});

		it('drops parked callbacks nobody claimed', async () => {
			await repository.insertEarlyCallback({}, NAMESPACE, '125', {
				payload: { id: 125 },
				payloadReceivedAt: new Date(),
			});

			const removed = await repository.pruneOlderThan({}, new Date(0), new Date(Date.now() + 1000));

			expect(removed).toBe(1);
		});
	});

	describe('forgetting an execution', () => {
		it('releases the keys it still holds and keeps its resolved history', async () => {
			const resolved = await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.markCompleted({}, resolved.id);
			await repository.insertWait({}, NAMESPACE, '126', claim);
			const claimed = await repository.insertWait({}, NAMESPACE, '127', claim);
			await repository.claimForResume({}, claimed.id, {
				payload: { id: 127 },
				payloadReceivedAt: new Date(),
			});

			await repository.deleteForExecution({}, claim.executionId);

			expect(await repository.findLive({}, NAMESPACE, '126')).toBeNull();
			expect(await repository.findLive({}, NAMESPACE, '127')).toBeNull();
			// A duplicate of the delivery that resolved '125' must still be told from a new
			// callback after the execution is over, which is the whole reason resolved rows exist.
			expect(await repository.findLatest({}, NAMESPACE, '125')).toMatchObject({
				status: 'completed',
			});
		});

		it('leaves the rows of other executions alone', async () => {
			await repository.insertWait({}, NAMESPACE, '125', claim);
			await repository.insertWait({}, NAMESPACE, '126', { ...claim, executionId: 'exec-2' });

			await repository.deleteForExecution({}, 'exec-1');

			expect(await repository.findLive({}, NAMESPACE, '126')).toMatchObject({
				executionId: 'exec-2',
			});
		});
	});

	it('serialises a registration race to exactly one winner', async () => {
		// Both sides run the check-then-insert unit of work the service uses.
		const register = async (executionId: string) =>
			await txRunner.run({}, async (ctx) => {
				const live = await repository.findLive(ctx, NAMESPACE, '125');
				if (live) throw new Error('already active');
				await repository.insertWait(ctx, NAMESPACE, '125', { ...claim, executionId });
			});

		const outcomes = await Promise.allSettled([register('exec-1'), register('exec-2')]);

		expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
		expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);
	});
});
