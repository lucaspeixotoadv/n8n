import { createWorkflow, testDb } from '@n8n/backend-test-utils';
import type { ExecutionNodeRun } from '@n8n/db';
import { ExecutionNodeRunRepository } from '@n8n/db';
import { Container } from '@n8n/di';
import type { ITaskData } from 'n8n-workflow';

import { ExecutionPersistence } from '@/executions/execution-persistence';

import { createExecution } from '../shared/db/executions';

const task = (marker: string): ITaskData =>
	({
		startTime: 0,
		executionTime: 0,
		executionIndex: 0,
		source: [],
		data: { main: [[{ json: { marker } }]] },
	}) as unknown as ITaskData;

describe('ExecutionNodeRunRepository', () => {
	let repository: ExecutionNodeRunRepository;
	let executionId: string;

	const row = (seq: number, nodeName: string, runIndex = 0): ExecutionNodeRun =>
		({
			executionId,
			seq,
			nodeName,
			runIndex,
			taskData: task(nodeName),
			createdAt: new Date(),
		}) as ExecutionNodeRun;

	beforeAll(async () => {
		await testDb.init();
		repository = Container.get(ExecutionNodeRunRepository);
	});

	beforeEach(async () => {
		await repository.delete({});
		const workflow = await createWorkflow();
		const execution = await createExecution({ status: 'running' }, workflow);
		executionId = execution.id;
	});

	afterAll(async () => {
		await testDb.terminate();
	});

	it('reads back an execution journal in the order it was written', async () => {
		await repository.append([row(1, 'Trigger'), row(2, 'Agent')]);

		const journal = await repository.findByExecution(executionId);

		expect(journal.map((entry) => entry.nodeName)).toEqual(['Trigger', 'Agent']);
	});

	it('treats a repeated append of the same position as a no-op', async () => {
		await repository.append([row(1, 'Trigger')]);
		await repository.append([row(1, 'Trigger')]);

		expect(await repository.findByExecution(executionId)).toHaveLength(1);
	});

	it('reports the highest position so a resume continues the same order', async () => {
		await repository.append([row(1, 'Trigger'), row(2, 'Agent')]);

		expect(await repository.findHighestSeq(executionId)).toBe(2);
	});

	it('reports zero for an execution that has journalled nothing', async () => {
		expect(await repository.findHighestSeq(executionId)).toBe(0);
	});

	it('releases only the positions a snapshot covers', async () => {
		await repository.append([row(1, 'Trigger'), row(2, 'Agent'), row(3, 'Tool')]);

		await repository.deleteUpTo(executionId, 2);

		const remaining = await repository.findByExecution(executionId);
		expect(remaining.map((entry) => entry.seq)).toEqual([3]);
	});

	it('is released with the execution it belongs to', async () => {
		const workflow = await createWorkflow();
		const execution = await createExecution({ status: 'running' }, workflow);
		await repository.append([
			{ ...row(1, 'Trigger'), executionId: execution.id } as ExecutionNodeRun,
		]);

		await Container.get(ExecutionPersistence).hardDelete({
			workflowId: workflow.id,
			executionId: execution.id,
			storedAt: execution.storedAt,
		});

		expect(await repository.findByExecution(execution.id)).toHaveLength(0);
	});
});
