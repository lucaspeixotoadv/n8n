import type { Logger } from '@n8n/backend-common';
import type { OperationContext } from '@n8n/db';

import type { CallbackWait } from '../callback-wait.entity';
import type { CallbackWaitRepository } from '../callback-wait.repository';
import type { IDataObject } from 'n8n-workflow';
import { UserError } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import type { CallbackWaitConfig } from '../callback-wait.config';
import { CallbackWaitService } from '../callback-wait.service';

const NAMESPACE = 'endpoint-a';
const OTHER_NAMESPACE = 'endpoint-b';

/** Runs the unit of work without a real transaction, keeping the call shape intact. */
const transactionRunner = {
	run: async <T>(ctx: OperationContext, fn: (ctx: OperationContext) => Promise<T>) => await fn(ctx),
};

const claim = {
	executionId: 'exec-1',
	toolCallId: 'call-1',
	nodeId: 'node-1',
	workflowId: 'wf-1',
};

function makeRow(overrides: Partial<CallbackWait> = {}): CallbackWait {
	return {
		id: 'row-1',
		namespace: NAMESPACE,
		correlationValue: '125',
		activeKey: `${NAMESPACE}:125`,
		status: 'waiting',
		executionId: 'exec-1',
		toolCallId: 'call-1',
		nodeId: 'node-1',
		workflowId: 'wf-1',
		payload: null,
		payloadReceivedAt: null,
		resolvedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as CallbackWait;
}

describe('CallbackWaitService', () => {
	let repository: ReturnType<typeof mock<CallbackWaitRepository>>;
	let service: CallbackWaitService;

	beforeEach(() => {
		repository = mock<CallbackWaitRepository>();
		service = new CallbackWaitService(
			mock<Logger>({ scoped: () => mock<Logger>() }) as unknown as Logger,
			repository,
			transactionRunner as never,
			mock<CallbackWaitConfig>({
				maxEarlyCallbacksPerNamespace: 10,
				maxCallbackBodyBytes: 65536,
			}),
		);
	});

	describe('registerWait', () => {
		it('registers a wait when the key is free', async () => {
			repository.findLive.mockResolvedValue(null);

			const result = await service.registerWait({
				namespace: NAMESPACE,
				correlationValue: '125',
				...claim,
				toolCallId: 'call-1',
			});

			expect(result).toEqual({ status: 'registered' });
			expect(repository.insertWait).toHaveBeenCalledWith(
				expect.anything(),
				NAMESPACE,
				'125',
				expect.objectContaining({ executionId: 'exec-1', nodeId: 'node-1' }),
			);
		});

		it('consumes a callback that arrived before the wait, without parking', async () => {
			const payload: IDataObject = { id: 125, status: 'DONE' };
			repository.findLive.mockResolvedValue(makeRow({ status: 'pendingCallback', payload }));
			repository.claimEarlyCallback.mockResolvedValue(true);

			const result = await service.registerWait({
				namespace: NAMESPACE,
				correlationValue: '125',
				...claim,
			});

			expect(result).toEqual({ status: 'resolved', payload });
			expect(repository.insertWait).not.toHaveBeenCalled();
		});

		it('refuses a second wait on a key that is already active', async () => {
			repository.findLive.mockResolvedValue(makeRow({ status: 'waiting' }));

			await expect(
				service.registerWait({ namespace: NAMESPACE, correlationValue: '125', ...claim }),
			).rejects.toThrow(UserError);
			expect(repository.insertWait).not.toHaveBeenCalled();
		});

		it('turns a unique-constraint failure into the same refusal', async () => {
			repository.findLive.mockResolvedValue(null);
			repository.insertWait.mockRejectedValue(new Error('UNIQUE constraint failed'));

			await expect(
				service.registerWait({ namespace: NAMESPACE, correlationValue: '125', ...claim }),
			).rejects.toThrow(UserError);
		});

		it('refuses when another registration claimed the parked callback first', async () => {
			repository.findLive.mockResolvedValue(makeRow({ status: 'pendingCallback', payload: {} }));
			repository.claimEarlyCallback.mockResolvedValue(false);

			await expect(
				service.registerWait({ namespace: NAMESPACE, correlationValue: '125', ...claim }),
			).rejects.toThrow(UserError);
		});
	});

	describe('correlate', () => {
		it('claims a parked wait exactly once', async () => {
			const row = makeRow({ status: 'waiting' });
			repository.findLive.mockResolvedValue(row);
			repository.claimForResume.mockResolvedValue(true);

			const outcome = await service.correlate(NAMESPACE, '125', { id: 125 });

			expect(outcome.kind).toBe('claimed');
		});

		it('ignores a delivery that lost the transition', async () => {
			repository.findLive.mockResolvedValue(makeRow({ status: 'waiting' }));
			repository.claimForResume.mockResolvedValue(false);

			const outcome = await service.correlate(NAMESPACE, '125', { id: 125 });

			expect(outcome.kind).toBe('ignored');
		});

		it('ignores a delivery while a resume is already in flight', async () => {
			repository.findLive.mockResolvedValue(makeRow({ status: 'resuming' }));

			const outcome = await service.correlate(NAMESPACE, '125', { id: 125 });

			expect(outcome.kind).toBe('ignored');
			expect(repository.claimForResume).not.toHaveBeenCalled();
		});

		it('parks a callback that has no wait yet', async () => {
			repository.findLive.mockResolvedValue(null);
			repository.findLatest.mockResolvedValue(null);
			repository.countEarlyCallbacks.mockResolvedValue(0);

			const outcome = await service.correlate(NAMESPACE, '125', { id: 125 });

			expect(outcome.kind).toBe('parked');
			expect(repository.insertEarlyCallback).toHaveBeenCalled();
		});

		it('does not re-park a duplicate that arrives after the wait resolved', async () => {
			repository.findLive.mockResolvedValue(null);
			repository.findLatest.mockResolvedValue(makeRow({ status: 'completed', activeKey: null }));

			const outcome = await service.correlate(NAMESPACE, '125', { id: 125, ts: 'later' });

			expect(outcome.kind).toBe('ignored');
			expect(repository.insertEarlyCallback).not.toHaveBeenCalled();
		});

		it('scopes the same correlation value to the endpoint it arrived on', async () => {
			repository.findLive.mockResolvedValue(null);
			repository.findLatest.mockResolvedValue(null);
			repository.countEarlyCallbacks.mockResolvedValue(0);

			await service.correlate(OTHER_NAMESPACE, '125', { id: 125 });

			expect(repository.findLive).toHaveBeenCalledWith(expect.anything(), OTHER_NAMESPACE, '125');
		});

		it('drops an early callback once the endpoint holds too many', async () => {
			repository.findLive.mockResolvedValue(null);
			repository.findLatest.mockResolvedValue(null);
			repository.countEarlyCallbacks.mockResolvedValue(10);

			const outcome = await service.correlate(NAMESPACE, '125', { id: 125 });

			expect(outcome.kind).toBe('ignored');
			expect(repository.insertEarlyCallback).not.toHaveBeenCalled();
		});

		it('drops an early callback whose body exceeds the stored size limit', async () => {
			repository.findLive.mockResolvedValue(null);
			repository.findLatest.mockResolvedValue(null);
			repository.countEarlyCallbacks.mockResolvedValue(0);

			const outcome = await service.correlate(NAMESPACE, '125', { blob: 'x'.repeat(70000) });

			expect(outcome.kind).toBe('ignored');
			expect(repository.insertEarlyCallback).not.toHaveBeenCalled();
		});
	});
});
