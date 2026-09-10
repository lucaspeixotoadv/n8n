import type { Logger } from '@n8n/backend-common';
import type { IExecutionResponse } from '@n8n/db';

import type { CallbackWait } from '../callback-wait.entity';
import type { ExecutionStatus, IRunExecutionData } from 'n8n-workflow';
import { NodeConnectionTypes } from 'n8n-workflow';
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
		payload: null,
		payloadReceivedAt: new Date(),
		resolvedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		...overrides,
	} as CallbackWait;
}

function makeExecution(status: ExecutionStatus, nodeId = NODE_ID): IExecutionResponse {
	const data = {
		resultData: {
			lastNodeExecuted: NODE_NAME,
			runData: { [NODE_NAME]: [{ startTime: 0, executionTime: 0, executionIndex: 0 }] },
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
		finished: false,
		mode: 'webhook',
		startedAt: new Date(),
		workflowData: { id: 'wf-1' },
		data,
	} as unknown as IExecutionResponse;
}

describe('CallbackWaitResumeService', () => {
	let executionPersistence: ReturnType<typeof mock<ExecutionPersistence>>;
	let workflowRunner: ReturnType<typeof mock<WorkflowRunner>>;
	let service: CallbackWaitResumeService;

	beforeEach(() => {
		executionPersistence = mock<ExecutionPersistence>();
		workflowRunner = mock<WorkflowRunner>();
		service = new CallbackWaitResumeService(
			mock<Logger>({ scoped: () => mock<Logger>() }) as unknown as Logger,
			executionPersistence,
			mock<OwnershipService>({
				getWorkflowProjectCached: async () => mock<{ id: string }>({ id: 'project-1' }) as never,
			}),
			workflowRunner,
			mock<EventService>(),
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

	it('reports a not-yet-parked execution instead of resuming it', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('running'));

		const outcome = await service.resume(makeWait(), { id: 125 });

		expect(outcome).toBe('notParkedYet');
		expect(workflowRunner.run).not.toHaveBeenCalled();
	});

	it('abandons a cancelled execution rather than resuming it', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('canceled'));

		const outcome = await service.resume(makeWait(), { id: 125 });

		expect(outcome).toBe('abandoned');
		expect(workflowRunner.run).not.toHaveBeenCalled();
	});

	it('abandons a callback whose execution no longer exists', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(undefined);

		expect(await service.resume(makeWait(), { id: 125 })).toBe('abandoned');
	});

	it('abandons a callback when the execution parked on a different node', async () => {
		executionPersistence.findSingleExecution.mockResolvedValue(makeExecution('waiting', 'other'));

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
