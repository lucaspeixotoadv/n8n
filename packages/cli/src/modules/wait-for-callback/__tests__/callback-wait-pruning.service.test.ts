import type { Logger } from '@n8n/backend-common';
import { Time } from '@n8n/constants';
import type { InstanceSettings } from 'n8n-core';
import { mock } from 'vitest-mock-extended';

import { CallbackWaitPruningService } from '../callback-wait-pruning.service';
import type { CallbackWaitConfig } from '../callback-wait.config';
import type { CallbackWaitRepository } from '../callback-wait.repository';

describe('CallbackWaitPruningService', () => {
	const repository = mock<CallbackWaitRepository>();

	function makeService(isLeader = true) {
		return new CallbackWaitPruningService(
			mock<Logger>({ scoped: () => mock<Logger>() }) as unknown as Logger,
			repository,
			mock<CallbackWaitConfig>({
				resolvedRetentionHours: 72,
				earlyCallbackRetentionHours: 168,
			}),
			mock<InstanceSettings>({ isLeader }),
		);
	}

	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		vi.setSystemTime(new Date('2026-01-10T00:00:00.000Z'));
		vi.clearAllMocks();
		repository.pruneOlderThan.mockResolvedValue(0);
	});

	afterEach(() => vi.useRealTimers());

	it('applies a separate window to resolved rows and to parked callbacks', async () => {
		await makeService().sweep();

		const [, resolvedCutoff, parkedCutoff] = repository.pruneOlderThan.mock.calls[0];
		expect(Date.now() - resolvedCutoff.getTime()).toBe(72 * Time.hours.toMilliseconds);
		expect(Date.now() - parkedCutoff.getTime()).toBe(168 * Time.hours.toMilliseconds);
	});

	it('sweeps on start and keeps sweeping on an interval', () => {
		const service = makeService();

		service.init();
		vi.advanceTimersByTime(2 * 60 * Time.minutes.toMilliseconds);
		service.stopSweeping();

		expect(repository.pruneOlderThan).toHaveBeenCalledTimes(3);
	});

	it('does not sweep from an instance that is not the leader', () => {
		makeService(false).init();

		expect(repository.pruneOlderThan).not.toHaveBeenCalled();
	});

	it('never lets a failing sweep escape', async () => {
		repository.pruneOlderThan.mockRejectedValue(new Error('database unavailable'));

		await expect(makeService().sweep()).resolves.toBeUndefined();
	});
});
