import { createPinia, setActivePinia } from 'pinia';
import { stringify } from 'flatted';
import { mock } from 'vitest-mock-extended';
import type { Router } from 'vue-router';
import type { ExecutionSnapshot } from '@n8n/api-types/push/execution';
import type { ITaskData } from 'n8n-workflow';

import { createWorkflowDocumentId } from '@/app/stores/workflowDocument.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useExecutionWatchStore } from '@/features/execution/executions/executionWatch.store';
import { createTestWorkflowExecutionResponse } from '@/__tests__/mocks';

import { executionSnapshot } from './executionSnapshot';
import type { PushHandlerOptions } from './types';

vi.mock('./executionFinished', () => ({
	refreshWatchingDocuments: vi.fn(),
	executionFinished: vi.fn(),
}));
vi.mock('@/features/execution/executions/executionWatch.api', () => ({
	watchExecution: vi.fn(async () => {}),
	unwatchExecution: vi.fn(async () => {}),
}));

import { executionFinished, refreshWatchingDocuments } from './executionFinished';

const task = (executionIndex: number, value: unknown): ITaskData =>
	({
		startTime: executionIndex,
		executionTime: 1,
		executionIndex,
		source: [],
		executionStatus: 'success',
		data: { main: [[{ json: { value } }]] },
	}) as ITaskData;

describe('executionSnapshot', () => {
	const editorDocumentId = createWorkflowDocumentId('wf-1');
	const previewDocumentId = createWorkflowDocumentId('preview');
	let options: PushHandlerOptions;

	function makeEvent(data: Partial<ExecutionSnapshot['data']> = {}): ExecutionSnapshot {
		return {
			type: 'executionSnapshot',
			data: { executionId: 'exec-1', workflowId: 'wf-1', status: 'running', ...data },
		};
	}

	function displayRunning(runData: Record<string, ITaskData[]>) {
		const store = useExecutionDataStore(createExecutionDataId('exec-1'));
		store.setExecution(
			createTestWorkflowExecutionResponse({
				id: 'exec-1',
				status: 'running',
				finished: false,
				data: { resultData: { runData } } as never,
			}),
		);
		return store;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		setActivePinia(createPinia());
		options = { router: mock<Router>(), documentId: editorDocumentId };
		useExecutionWatchStore().observe(previewDocumentId, 'exec-1');
	});

	it('does nothing for an execution no document shows', async () => {
		useExecutionWatchStore().observe(previewDocumentId, null);
		const store = displayRunning({});

		await executionSnapshot(
			makeEvent({ flattedRunData: stringify({ A: [task(0, 'a')] }) }),
			options,
		);

		expect(store.execution?.data?.resultData.runData).toEqual({});
	});

	it('does nothing before the document has loaded the execution', async () => {
		await executionSnapshot(
			makeEvent({ flattedRunData: stringify({ A: [task(0, 'a')] }) }),
			options,
		);

		expect(useExecutionDataStore(createExecutionDataId('exec-1')).execution).toBeNull();
	});

	it('adds the runs the snapshot brings and keeps the ones it does not know', async () => {
		// `B` reached the session as a live event after the subscription was registered but
		// before the snapshot was built, so the snapshot cannot know it.
		const store = displayRunning({ A: [task(0, 'stale')], B: [task(1, 'live')] });

		await executionSnapshot(
			makeEvent({ flattedRunData: stringify({ A: [task(0, 'fresh')], C: [task(2, 'c')] }) }),
			options,
		);

		const runData = store.execution?.data?.resultData.runData;
		expect(runData?.A[0].data?.main[0]?.[0]?.json).toEqual({ value: 'fresh' });
		expect(runData?.B[0].data?.main[0]?.[0]?.json).toEqual({ value: 'live' });
		expect(runData?.C[0].data?.main[0]?.[0]?.json).toEqual({ value: 'c' });
	});

	it('applies the same snapshot twice without duplicating a run', async () => {
		const store = displayRunning({});
		const event = makeEvent({ flattedRunData: stringify({ A: [task(0, 'a'), task(3, 'a2')] }) });

		await executionSnapshot(event, options);
		await executionSnapshot(event, options);

		expect(store.execution?.data?.resultData.runData.A).toHaveLength(2);
	});

	it('moves the displayed execution to the status the snapshot reports', async () => {
		const store = displayRunning({});

		await executionSnapshot(makeEvent({ status: 'waiting' }), options);

		expect(store.execution?.status).toBe('waiting');
	});

	it('stops showing a node as executing when the execution is parked', async () => {
		displayRunning({});
		const stateStore = useWorkflowExecutionStateStore(previewDocumentId);
		stateStore.executingNode.addExecutingNode('A', 0);

		await executionSnapshot(makeEvent({ status: 'waiting' }), options);

		expect(stateStore.executingNode.isNodeExecuting('A')).toBe(false);
	});

	it('treats a terminal snapshot as the finish the session missed', async () => {
		displayRunning({});

		await executionSnapshot(makeEvent({ status: 'success' }), options);

		expect(refreshWatchingDocuments).toHaveBeenCalledWith('exec-1', [previewDocumentId]);
		expect(executionFinished).not.toHaveBeenCalled();
	});

	it('settles a terminal snapshot the way the finish would for the document that started the run', async () => {
		displayRunning({});
		useWorkflowExecutionStateStore(editorDocumentId).setActiveExecutionId('exec-1');

		await executionSnapshot(makeEvent({ status: 'error' }), options);

		expect(executionFinished).toHaveBeenCalledWith(
			{
				type: 'executionFinished',
				data: { executionId: 'exec-1', workflowId: 'wf-1', status: 'error' },
			},
			options,
		);
		expect(refreshWatchingDocuments).not.toHaveBeenCalled();
	});

	describe('the node the execution is on', () => {
		const started = (executionIndex: number) => ({
			startTime: executionIndex,
			executionIndex,
			source: [],
		});

		it('is shown as executing, replacing whatever the document showed before', async () => {
			const store = displayRunning({});
			const stateStore = useWorkflowExecutionStateStore(previewDocumentId);
			// A node the session saw start before the snapshot was built; the snapshot does
			// not name it, so it has finished meanwhile.
			stateStore.executingNode.addExecutingNode('A', 0);

			await executionSnapshot(
				makeEvent({
					executingNodes: [{ nodeName: 'B', sequenceNumber: 2, data: started(1) }],
				}),
				options,
			);

			expect(stateStore.executingNode.isNodeExecuting('A')).toBe(false);
			expect(stateStore.executingNode.isNodeExecuting('B')).toBe(true);
			expect(store.executionStartedData?.[1]).toEqual({ B: [started(1)] });
		});

		it('is the latest of nested runs, and the earlier ones are still recorded as started', async () => {
			const store = displayRunning({});
			const stateStore = useWorkflowExecutionStateStore(previewDocumentId);

			await executionSnapshot(
				makeEvent({
					executingNodes: [
						{ nodeName: 'Agent', sequenceNumber: 2, data: started(1) },
						{ nodeName: 'Tool', sequenceNumber: 4, data: started(2) },
					],
				}),
				options,
			);

			expect(stateStore.executingNode.isNodeExecuting('Tool')).toBe(true);
			expect(stateStore.executingNode.isNodeExecuting('Agent')).toBe(false);
			expect(Object.keys(store.executionStartedData?.[1] ?? {})).toEqual(['Agent', 'Tool']);
		});

		it('lets the events that follow the snapshot supersede it, and drops the ones before it', async () => {
			displayRunning({});
			const stateStore = useWorkflowExecutionStateStore(previewDocumentId);

			await executionSnapshot(
				makeEvent({ executingNodes: [{ nodeName: 'B', sequenceNumber: 2, data: started(1) }] }),
				options,
			);
			// Older than the snapshot: a late delivery of a node that has since finished.
			stateStore.executingNode.addExecutingNode('A', 0);
			expect(stateStore.executingNode.isNodeExecuting('B')).toBe(true);
			// Newer than the snapshot.
			stateStore.executingNode.addExecutingNode('C', 4);
			expect(stateStore.executingNode.isNodeExecuting('C')).toBe(true);
		});

		it('is none when the snapshot names no running node', async () => {
			displayRunning({});
			const stateStore = useWorkflowExecutionStateStore(previewDocumentId);
			stateStore.executingNode.addExecutingNode('A', 0);

			await executionSnapshot(makeEvent({ status: 'running' }), options);

			expect(stateStore.executingNode.isNodeExecuting('A')).toBe(false);
		});
	});
});
