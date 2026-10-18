import type { Logger } from '@n8n/backend-common';
import { Time } from '@n8n/constants';
import { mock } from 'vitest-mock-extended';

import { CallbackWaitPruningTask } from '../callback-wait-pruning.task';
import type { CallbackWaitConfig } from '../callback-wait.config';
import type { CallbackWaitRepository } from '../callback-wait.repository';

describe('CallbackWaitPruningTask', () => {
	const repository = mock<CallbackWaitRepository>();
	const task = new CallbackWaitPruningTask(
		mock<Logger>({ scoped: () => mock<Logger>() }) as unknown as Logger,
		repository,
		mock<CallbackWaitConfig>({
			resolvedRetentionHours: 72,
			earlyCallbackRetentionHours: 168,
		}),
	);

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-10T00:00:00.000Z'));
		vi.clearAllMocks();
		repository.pruneOlderThan.mockResolvedValue(0);
	});

	afterEach(() => vi.useRealTimers());

	it('declares an hourly sweep on the leader that also runs on takeover', () => {
		expect(task.name).toBe('callback-wait-pruning');
		expect(task.schedule).toEqual({ kind: 'interval', intervalSeconds: 3600 });
		expect(task.effects).toBe('idempotent');
		expect(task.placement).toEqual({ scope: 'cluster', durable: true, runOnTakeover: true });
		expect(task.retryDelaySeconds).toBe(30);
	});

	it('applies a separate window to resolved rows and to parked callbacks', async () => {
		await task.run();

		const [, resolvedCutoff, parkedCutoff] = repository.pruneOlderThan.mock.calls[0];
		expect(Date.now() - resolvedCutoff.getTime()).toBe(72 * Time.hours.toMilliseconds);
		expect(Date.now() - parkedCutoff.getTime()).toBe(168 * Time.hours.toMilliseconds);
	});

	it('lets a failing sweep reach the runner, which retries it', async () => {
		repository.pruneOlderThan.mockRejectedValue(new Error('database unavailable'));

		await expect(task.run()).rejects.toThrow('database unavailable');
	});
});
