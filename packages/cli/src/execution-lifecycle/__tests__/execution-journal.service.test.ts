import type { Logger } from '@n8n/backend-common';
import type { ExecutionNodeRun } from '@n8n/db';
import { ExecutionNodeRunRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type { IRunExecutionData, ITaskData } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import type { ExecutionJournalConfig } from '@/execution-lifecycle/execution-journal.config';
import { ExecutionJournalService } from '@/execution-lifecycle/execution-journal.service';

const EXECUTION_ID = 'exec-1';

const task = (marker: string): ITaskData =>
	({
		startTime: 0,
		executionTime: 0,
		executionIndex: 0,
		source: [],
		data: { main: [[{ json: { marker } }]] },
	}) as unknown as ITaskData;

const runExecutionData = (runData: Record<string, ITaskData[]>): IRunExecutionData =>
	({ resultData: { runData } }) as unknown as IRunExecutionData;

describe('ExecutionJournalService', () => {
	let repository: ReturnType<typeof mock<ExecutionNodeRunRepository>>;

	function makeService(overrides: Partial<ExecutionJournalConfig> = {}) {
		repository = mock<ExecutionNodeRunRepository>();
		repository.findHighestSeq.mockResolvedValue(0);
		Container.set(ExecutionNodeRunRepository, repository);

		return new ExecutionJournalService(
			mock<Logger>({ scoped: () => mock<Logger>() }) as unknown as Logger,
			mock<ExecutionJournalConfig>({ maxTaskBytes: 1024, ...overrides }),
		);
	}

	const appended = (): ExecutionNodeRun[] =>
		repository.append.mock.calls.flatMap(([rows]) => rows);

	it('records a node run as it finishes', async () => {
		const service = makeService();
		const trigger = task('trigger');

		await service.recordNodeRun(
			EXECUTION_ID,
			'Trigger',
			trigger,
			runExecutionData({ Trigger: [trigger] }),
		);

		expect(appended()).toEqual([
			expect.objectContaining({
				executionId: EXECUTION_ID,
				nodeName: 'Trigger',
				runIndex: 0,
				taskData: trigger,
			}),
		]);
	});

	it('orders runs so a consumer can tell what it has already seen', async () => {
		const service = makeService();
		const first = task('a');
		const second = task('b');

		await service.recordNodeRun(EXECUTION_ID, 'A', first, runExecutionData({ A: [first] }));
		await service.recordNodeRun(EXECUTION_ID, 'B', second, runExecutionData({ B: [second] }));

		expect(appended().map((row) => row.seq)).toEqual([1, 2]);
	});

	it('continues the order of a resumed execution instead of restarting it', async () => {
		const service = makeService();
		repository.findHighestSeq.mockResolvedValue(7);
		const resumed = task('resumed');

		await service.recordNodeRun(EXECUTION_ID, 'A', resumed, runExecutionData({ A: [resumed] }));

		expect(appended()[0].seq).toBe(8);
	});

	it('records the position of a node that ran more than once', async () => {
		const service = makeService();
		const secondRun = task('second');

		await service.recordNodeRun(
			EXECUTION_ID,
			'Loop',
			secondRun,
			runExecutionData({ Loop: [task('first'), secondRun] }),
		);

		expect(appended()[0].runIndex).toBe(1);
	});

	it('journals an oversized task as a placeholder rather than dropping the run', async () => {
		const service = makeService({ maxTaskBytes: 10 });
		const huge = task('x'.repeat(5000));

		await service.recordNodeRun(EXECUTION_ID, 'Big', huge, runExecutionData({ Big: [huge] }));

		const [row] = appended();
		expect(row.nodeName).toBe('Big');
		expect(row.taskData.data).toEqual({ journalTruncated: true });
	});

	it('never fails an execution because its progress could not be recorded', async () => {
		const service = makeService();
		repository.append.mockRejectedValue(new Error('database unavailable'));
		const any = task('a');

		await expect(
			service.recordNodeRun(EXECUTION_ID, 'A', any, runExecutionData({ A: [any] })),
		).resolves.toBeUndefined();
	});

	describe('forget', () => {
		it('releases only what the snapshot now covers', async () => {
			const service = makeService();
			const any = task('a');
			await service.recordNodeRun(EXECUTION_ID, 'A', any, runExecutionData({ A: [any] }));

			await service.forget(EXECUTION_ID);

			expect(repository.deleteUpTo).toHaveBeenCalledWith(EXECUTION_ID, 1);
		});

		it('lets a later run of the same execution start a fresh order lookup', async () => {
			const service = makeService();
			const any = task('a');
			await service.recordNodeRun(EXECUTION_ID, 'A', any, runExecutionData({ A: [any] }));
			await service.forget(EXECUTION_ID);

			repository.findHighestSeq.mockResolvedValue(3);
			await service.recordNodeRun(EXECUTION_ID, 'B', any, runExecutionData({ B: [any] }));

			expect(appended().map((row) => row.seq)).toEqual([1, 4]);
		});
	});
});
