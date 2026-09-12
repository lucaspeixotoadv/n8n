import type { Logger } from '@n8n/backend-common';
import type { IExecutionResponse } from '@n8n/db';

import type { CallbackWait } from '../callback-wait.entity';
import type { ExecutionStatus, IRunExecutionData } from 'n8n-workflow';
import { NodeConnectionTypes, WAIT_INDEFINITELY } from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { ExecutionAlreadyResumingError } from '@/errors/execution-already-resuming.error';
import type { EventService } from '@/events/event.service';
import type { ExecutionPersistence } from '@/executions/execution-persistence';
import type { OwnershipService } from '@/services/ownership.service';
import { CallbackWaitResumeService } from '../callback-wait-resume.service';
import type { WorkflowRunner } from '@/workflow-runner';

const NODE_ID = 'node-1';
const NODE_NAME = 'Wait for Callback';

function makeWait(overrides: Partial<CallbackWait> = {}): CallbackWait {
	return {
		id: 'row-1',
		namespace: 'endpoint-a',
		correlationValue: '125',
		activeKey: null,
		status: 'resuming',
		executionId: 'exec-1',
		toolCallId: 'call-1',
		nodeId: NODE_ID,
		workflowId: 'wf-1',
		userId: 'user-1',
		payload: null,
		payloadReceivedAt: new Date(),
		resolvedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as CallbackWait;
}

/** The arguments the model passed to the tool call, as the engine records them on its run. */
const MODEL_ARGUMENTS = { ai_tool: [[{ json: { waitIdentifier: '125' } }]] };

function makeExecution(
	status: ExecutionStatus,
	{
		nodeId = NODE_ID,
		finished = false,
		error,
	}: { nodeId?: string; finished?: boolean; error?: unknown } = {},
): IExecutionResponse {
	const data = {
		// Still set from when the tool parked: the engine treats a resumed execution that
		// carries it as waiting, and handles the parked node itself.
		waitTill: WAIT_INDEFINITELY,
		resultData: {
			lastNodeExecuted: NODE_NAME,
			runData: {
				[NODE_NAME]: [
					{ startTime: 0, executionTime: 0, executionIndex: 0, inputOverride: MODEL_ARGUMENTS },
				],
			},
			...(error !== undefined && { error }),
		},
		executionData: {
			nodeExecutionStack: [
				{ node: { id: nodeId, name: NODE_NAME }, data: { main: [[]] }, source: null },
			],
		},
	} as unknown as IRunExecutionData;

	return {
		id: 'exec-1',
		status,
		finished,
		mode: 'webhook',
		startedAt: new Date(),
		workflowData: { id: 'wf-1' },
		data,
	} as unknown as IExecutionResponse;
}

describe('CallbackWaitResumeService', () => {
	let executionPersistence: ReturnType<typeof mock<ExecutionPersistence>>;
	let workflowRunner: ReturnType<typeof mock<WorkflowRunner>>;
	let eventService: ReturnType<typeof mock<EventService>>;
	let service: CallbackWaitResumeService;

	beforeEach(() => {
		executionPersistence = mock<ExecutionPersistence>();
		workflowRunner = mock<WorkflowRunner>();
		eventService = mock<EventService>();
		service = new CallbackWaitResumeService(
			mock<Logger>({ scoped: () => mock<Logger>() }) as unknown as Logger,
			executionPersistence,
			mock<OwnershipService>({
				getWorkflowProjectCached: async () => mock<{ id: string }>({ id: 'project-1' }) as never,
			}),
			workflowRunner,
			eventService,
		);
	});

	it('makes the callback body the parked node input and resumes', async () => {
		const execution = makeExecution('waiting');
		executionPersistence.findSingleExecution.mockResolvedValue(execution);

		const outcome = await service.resume(makeWait(), { id: 125, status: 'DONE' });

		expect(outcome).toBe('resumed');

		const stackEntry = execution.data.executionData!.nodeExecutionStack[0];
		expect(stackEntry.data.main).toEqual([[{ json: { id: 125, status: 'DONE' } }]]);
		expect(stackEntry.node.rewireOutputLogTo).toBe(NodeConnectionTypes.AiTool);
		expect(workflowRunner.run).toHaveBeenCalledWith(expect.anything(), false, false, {
			executionId: 'exec-1',
			expectedStatus: 'waiting',
		});
	});

	it('hands the engine an execution it will not treat as waiting', async () => {
		const execution = makeExecution('waiting');
		executionPersistence.findSingleExecution.mockResolvedValue(execution);

		await service.resume(makeWait(), { id: 125 });

		// Both are the engine's own waiting-state handling, done here instead: it disables the
		// node so the wait does not start over, and it only runs while `waitTill` is set.
		expect(execution.data.waitTill).toBeUndefined();
		expect(execution.data.executionData!.nodeExecutionStack[0].node.disabled).toBe(true);
	});

	it("keeps the model's arguments on the resumed run", async () => {
		const execution = makeExecution('waiting');
		executionPersistence.findSingleExecution.mockResolvedValue(execution);

		await service.resume(makeWait(), { id: 125 });

		// The parked run is replaced by a placeholder the engine merges the resumed run into.
		// Had the engine still seen the execution as waiting, it would pop that placeholder and
		// the run would show no input at all.
		expect(execution.data.resultData.runData[NODE_NAME]).toEqual([
			expect.objectContaining({ inputOverride: MODEL_ARGUMENTS }),
		]);
	});

	it('resumes as the user the run parked as, so the segment stays observable', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('waiting'));

		await service.resume(makeWait({ userId: 'user-1' }), { id: 125 });

		// The push hooks fail closed without a user: no node data reaches the UI at all.
		const [data] = workflowRunner.run.mock.calls[0];
		expect(data.userId).toBe('user-1');
	});

	it('resumes a run that parked without a user without one', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('waiting'));

		await service.resume(makeWait({ userId: null }), { id: 125 });

		expect(workflowRunner.run.mock.calls[0][0].userId).toBeUndefined();
	});

	it('gives the resumed segment a fresh timeout instead of one measured from the original start', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('waiting'));

		await service.resume(makeWait(), { id: 125 });

		// With `startedAt` the runner subtracts the time already spent — a park longer than the
		// workflow timeout would then stop the execution the moment it resumed.
		expect(workflowRunner.run.mock.calls[0][0]).not.toHaveProperty('startedAt');
	});

	it('reports the resume as coming from a webhook', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('waiting'));

		await service.resume(makeWait(), { id: 125 });

		expect(eventService.emit).toHaveBeenCalledWith(
			'execution-resumed',
			expect.objectContaining({ executionId: 'exec-1', resumeSource: 'webhook' }),
		);
	});

	it.each<ExecutionStatus>(['running', 'new'])(
		'reports an execution that is still %s instead of resuming it',
		async (status) => {
			executionPersistence.findSingleExecution.mockResolvedValue(makeExecution(status));

			const outcome = await service.resume(makeWait(), { id: 125 });

			expect(outcome).toBe('notParkedYet');
			expect(workflowRunner.run).not.toHaveBeenCalled();
		},
	);

	it('abandons a cancelled execution rather than resuming it', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('canceled'));

		const outcome = await service.resume(makeWait(), { id: 125 });

		expect(outcome).toBe('abandoned');
		expect(workflowRunner.run).not.toHaveBeenCalled();
	});

	it('abandons an execution that already finished, whatever its status says', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(
			makeExecution('waiting', { finished: true }),
		);

		expect(await service.resume(makeWait(), { id: 125 })).toBe('abandoned');
		expect(workflowRunner.run).not.toHaveBeenCalled();
	});

	it('abandons an execution that stopped on an error', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(
			makeExecution('waiting', { error: { message: 'boom' } }),
		);

		expect(await service.resume(makeWait(), { id: 125 })).toBe('abandoned');
		expect(workflowRunner.run).not.toHaveBeenCalled();
	});

	it('abandons a wait that never got an execution', async () => {
		expect(await service.resume(makeWait({ executionId: null }), { id: 125 })).toBe('abandoned');
		expect(executionPersistence.findSingleExecution).not.toHaveBeenCalled();
	});

	it('abandons a callback whose execution no longer exists', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(undefined);

		expect(await service.resume(makeWait(), { id: 125 })).toBe('abandoned');
	});

	it('abandons a callback when the execution parked on a different node', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(
			makeExecution('waiting', { nodeId: 'other' }),
		);

		const outcome = await service.resume(makeWait(), { id: 125 });

		expect(outcome).toBe('abandoned');
		expect(workflowRunner.run).not.toHaveBeenCalled();
	});

	it('treats a resume another process already claimed as done', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('waiting'));
		workflowRunner.run.mockRejectedValue(new ExecutionAlreadyResumingError('exec-1'));

		expect(await service.resume(makeWait(), { id: 125 })).toBe('resumed');
	});
});
