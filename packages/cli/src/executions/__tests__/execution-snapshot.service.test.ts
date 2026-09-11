import type { ExecutionNodeRun, ExecutionNodeRunRepository, IExecutionResponse } from '@n8n/db';
import type { ExecutionStatus, IRunData, ITaskData, IWorkflowSettings } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { ExecutionSnapshotService } from '@/executions/execution-snapshot.service';

const task = (marker: string): ITaskData =>
	({
		startTime: 0,
		executionTime: 0,
		executionIndex: 0,
		source: [],
		data: { main: [[{ json: { marker } }]] },
	}) as unknown as ITaskData;

const journalRow = (
	seq: number,
	nodeName: string,
	runIndex: number,
	taskData: ITaskData,
): ExecutionNodeRun =>
	({ executionId: 'exec-1', seq, nodeName, runIndex, taskData }) as ExecutionNodeRun;

const execution = (
	status: ExecutionStatus,
	runData: IRunData = {},
	settings: IWorkflowSettings = { liveExecutionProgress: true },
): IExecutionResponse =>
	({
		id: 'exec-1',
		status,
		workflowData: { settings },
		data: { resultData: { runData, lastNodeExecuted: undefined } },
	}) as unknown as IExecutionResponse;

describe('ExecutionSnapshotService', () => {
	let repository: ReturnType<typeof mock<ExecutionNodeRunRepository>>;
	let service: ExecutionSnapshotService;

	beforeEach(() => {
		repository = mock<ExecutionNodeRunRepository>();
		repository.findByExecution.mockResolvedValue([]);
		service = new ExecutionSnapshotService(repository);
	});

	it('leaves an execution untouched when its workflow does not journal', async () => {
		const running = execution('running', {}, { liveExecutionProgress: false });

		expect(await service.complete(running)).toBe(running);
		expect(repository.findByExecution).not.toHaveBeenCalled();
	});

	it.each(['success', 'error', 'canceled', 'crashed'] as ExecutionStatus[])(
		'leaves a %s execution untouched and does not query the journal',
		async (status) => {
			const finished = execution(status, { A: [task('a')] });

			expect(await service.complete(finished)).toBe(finished);
			expect(repository.findByExecution).not.toHaveBeenCalled();
		},
	);

	it.each(['new', 'running', 'waiting'] as ExecutionStatus[])(
		'completes a %s execution with what has run since its last save',
		async (status) => {
			repository.findByExecution.mockResolvedValue([journalRow(1, 'Trigger', 0, task('trigger'))]);

			const completed = await service.complete(execution(status));

			expect(completed.data.resultData.runData.Trigger).toEqual([task('trigger')]);
		},
	);

	it('shows the trigger of a running execution whose snapshot is still empty', async () => {
		repository.findByExecution.mockResolvedValue([
			journalRow(1, 'Trigger', 0, task('trigger')),
			journalRow(2, 'Agent', 0, task('agent')),
		]);

		const completed = await service.complete(execution('running'));

		expect(Object.keys(completed.data.resultData.runData)).toEqual(['Trigger', 'Agent']);
		expect(completed.data.resultData.lastNodeExecuted).toBe('Agent');
	});

	it('prefers the journalled run over an overlapping snapshot entry', async () => {
		const stale = task('stale');
		const recorded = task('recorded');
		repository.findByExecution.mockResolvedValue([journalRow(1, 'A', 0, recorded)]);

		const completed = await service.complete(execution('running', { A: [stale] }));

		expect(completed.data.resultData.runData.A).toEqual([recorded]);
	});

	it('keeps both runs of a node that ran twice', async () => {
		repository.findByExecution.mockResolvedValue([
			journalRow(1, 'Loop', 0, task('first')),
			journalRow(2, 'Loop', 1, task('second')),
		]);

		const completed = await service.complete(execution('running'));

		expect(completed.data.resultData.runData.Loop).toEqual([task('first'), task('second')]);
	});

	it('does not mutate the execution it was given', async () => {
		repository.findByExecution.mockResolvedValue([journalRow(1, 'A', 0, task('a'))]);
		const original = execution('running');

		await service.complete(original);

		expect(original.data.resultData.runData).toEqual({});
	});

	it('returns the execution unchanged when nothing has been journalled', async () => {
		const running = execution('running', { A: [task('a')] });

		expect(await service.complete(running)).toBe(running);
	});
});
