import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { stringify } from 'flatted';
import { mock } from 'vitest-mock-extended';
import { nextTick, ref } from 'vue';
import type { Router } from 'vue-router';
import type { PushMessage } from '@n8n/api-types';
import type { ITaskData } from 'n8n-workflow';
import { STORES } from '@n8n/stores';
import { createTestNode, createTestWorkflow } from '@/__tests__/mocks';
import { mockedStore } from '@/__tests__/utils';
import type { IWorkflowDb } from '@/Interface';
import type { IExecutionResponse } from '@/features/execution/executions/executions.types';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { usePushConnectionStore } from '@/app/stores/pushConnection.store';
import { usePushConnection } from '@/app/composables/usePushConnection';
import { createExecutionPreviewDocumentId } from '@/app/stores/workflowDocument.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useExecutionWatchStore } from '@/features/execution/executions/executionWatch.store';
import { useExecutionPreviewDocument } from '@/features/execution/executions/composables/useExecutionPreviewDocument';

vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({ showMessage: vi.fn(), showError: vi.fn() }),
}));
vi.mock('@n8n/composables/useTelemetry', () => ({ useTelemetry: () => ({ track: vi.fn() }) }));
vi.mock('@/app/composables/useExternalHooks', () => ({
	useExternalHooks: () => ({ run: vi.fn() }),
}));
vi.mock('@/features/ai/assistant/assistant.store', () => ({
	useAssistantStore: () => ({ onNodeExecution: vi.fn() }),
}));
vi.mock('vue-router', async (importOriginal) => ({
	...(await importOriginal()),
	useRouter: () => ({ push: vi.fn() }),
	useRoute: () => ({}),
}));

const WORKFLOW_ID = 'wf-1';
const VERSION_ID = 'v1';
const EXECUTION_ID = '42';
const nodeA = createTestNode({ id: 'node-a', name: 'Node A' });
const nodeB = createTestNode({ id: 'node-b', name: 'Node B' });
const nodeC = createTestNode({ id: 'node-c', name: 'Node C' });

const task = (executionIndex: number, value: unknown): ITaskData =>
	({
		startTime: executionIndex,
		executionTime: 1,
		executionIndex,
		source: [],
		executionStatus: 'success',
		data: { main: [[{ json: { value } }]] },
	}) as ITaskData;

/** The first output item of a node's run, as displayed. */
const output = (runs: readonly unknown[] | undefined, index = 0) =>
	(runs?.[index] as ITaskData | undefined)?.data?.main[0]?.[0]?.json;

function execution(overrides: Partial<IExecutionResponse> = {}): IExecutionResponse {
	return {
		id: EXECUTION_ID,
		workflowData: createTestWorkflow({
			id: WORKFLOW_ID,
			versionId: VERSION_ID,
			nodes: [nodeA, nodeB, nodeC],
			connections: {},
		}),
		finished: false,
		mode: 'webhook',
		status: 'running',
		startedAt: new Date(),
		createdAt: new Date(),
		data: { resultData: { runData: { 'Node A': [task(0, 'a')] }, lastNodeExecuted: 'Node A' } },
		...overrides,
	} as IExecutionResponse;
}

/**
 * The whole client side of observing an execution someone else is running, as it runs in
 * the app: the preview loads the execution, the watch store subscribes, the push pipeline
 * routes every event through the same handlers a manual run in the editor goes through,
 * and the preview's own stores are what the canvas renders.
 */
describe('observing a running execution', () => {
	const documentId = createExecutionPreviewDocumentId(WORKFLOW_ID, VERSION_ID);
	let workflowsStore: ReturnType<typeof mockedStore<typeof useWorkflowsStore>>;
	let pushStore: ReturnType<typeof usePushConnectionStore>;
	let sent: unknown[];
	const isConnected = ref(true);

	/** Delivers a server message the way the connection does. */
	function deliver(message: PushMessage) {
		for (const handler of pushStore.onMessageReceivedHandlers) handler(message);
	}

	const stateStore = () => useWorkflowExecutionStateStore(documentId);
	const dataStore = () => useExecutionDataStore(createExecutionDataId(EXECUTION_ID));
	const runData = () => dataStore().execution?.data?.resultData.runData;

	beforeEach(() => {
		setActivePinia(
			createTestingPinia({
				stubActions: false,
				initialState: {
					[STORES.NODE_TYPES]: {},
					[STORES.WORKFLOWS]: {
						workflowId: WORKFLOW_ID,
						workflow: mock<IWorkflowDb>({
							id: WORKFLOW_ID,
							nodes: [],
							connections: {},
							tags: [],
							usedCredentials: [],
						}),
					},
					[STORES.SETTINGS]: { settings: { enterprise: {} } },
				},
			}),
		);
		workflowsStore = mockedStore(useWorkflowsStore);
		workflowsStore.getExecution = vi.fn().mockResolvedValue(execution());
		workflowsStore.fetchExecutionDataById = vi.fn();
		pushStore = usePushConnectionStore();
		sent = [];
		vi.spyOn(pushStore, 'send').mockImplementation((message) => sent.push(message));
		isConnected.value = true;
		vi.spyOn(pushStore, 'isConnected', 'get').mockImplementation(() => isConnected.value);
		usePushConnection({ router: mock<Router>() }).initialize();
	});

	async function open() {
		const preview = useExecutionPreviewDocument({ executionId: EXECUTION_ID });
		await preview.load();
		return preview;
	}

	it('subscribes to the execution and shows what it already did', async () => {
		await open();

		expect(sent).toEqual([{ type: 'subscribeToExecution', executionId: EXECUTION_ID }]);
		expect(useExecutionWatchStore().documentsWatching(EXECUTION_ID)).toEqual([documentId]);
		expect(stateStore().activeExecutionStatusByNodeId.get('node-a')?.value).toBe('success');
		expect(stateStore().activeExecutionStatusByNodeId.get('node-b')?.value).toBe('new');
	});

	it('follows each node as it starts and finishes, output included', async () => {
		await open();

		deliver({
			type: 'nodeExecuteBefore',
			data: {
				executionId: EXECUTION_ID,
				nodeName: 'Node B',
				sequenceNumber: 0,
				data: { startTime: 2, executionIndex: 1, source: [] },
			},
		});
		await vi.waitFor(() =>
			expect(stateStore().executionRunningByNodeId.get('node-b')?.value).toBe(true),
		);

		deliver({
			type: 'nodeExecuteAfter',
			data: {
				executionId: EXECUTION_ID,
				nodeName: 'Node B',
				sequenceNumber: 1,
				itemCountByConnectionType: { main: [1] },
				data: {
					startTime: 2,
					executionTime: 5,
					executionIndex: 1,
					source: [],
					executionStatus: 'success',
				},
			},
		});
		await vi.waitFor(() =>
			expect(stateStore().executionRunningByNodeId.get('node-b')?.value).toBe(false),
		);
		expect(stateStore().activeExecutionStatusByNodeId.get('node-b')?.value).toBe('success');

		deliver({
			type: 'nodeExecuteAfterData',
			data: {
				executionId: EXECUTION_ID,
				nodeName: 'Node B',
				itemCountByConnectionType: { main: [1] },
				data: task(1, 'b'),
			},
		});
		await vi.waitFor(() => expect(output(runData()?.['Node B'])).toEqual({ value: 'b' }));
	});

	it('reconciles the snapshot the subscription answers with, without losing what came first', async () => {
		await open();
		// A node that finished after the subscription was registered but before the server
		// built the snapshot: its events arrive first, and the snapshot does not know it.
		deliver({
			type: 'nodeExecuteAfter',
			data: {
				executionId: EXECUTION_ID,
				nodeName: 'Node C',
				sequenceNumber: 0,
				itemCountByConnectionType: { main: [1] },
				data: {
					startTime: 3,
					executionTime: 1,
					executionIndex: 2,
					source: [],
					executionStatus: 'success',
				},
			},
		});
		deliver({
			type: 'nodeExecuteAfterData',
			data: {
				executionId: EXECUTION_ID,
				nodeName: 'Node C',
				itemCountByConnectionType: { main: [1] },
				data: task(2, 'c'),
			},
		});
		await vi.waitFor(() => expect(output(runData()?.['Node C'])).toEqual({ value: 'c' }));

		deliver({
			type: 'executionSnapshot',
			data: {
				executionId: EXECUTION_ID,
				workflowId: WORKFLOW_ID,
				status: 'running',
				flattedRunData: stringify({ 'Node A': [task(0, 'a')], 'Node B': [task(1, 'b')] }),
			},
		});

		await vi.waitFor(() => expect(output(runData()?.['Node B'])).toEqual({ value: 'b' }));
		expect(output(runData()?.['Node C'])).toEqual({ value: 'c' });
		expect(runData()?.['Node A']).toHaveLength(1);
		expect(stateStore().activeExecutionStatusByNodeId.get('node-b')?.value).toBe('success');
	});

	it('catches up through a renewed subscription after the connection was lost', async () => {
		await open();
		sent.length = 0;

		isConnected.value = false;
		await nextTick();
		isConnected.value = true;
		await nextTick();

		expect(sent).toEqual([{ type: 'subscribeToExecution', executionId: EXECUTION_ID }]);

		// What the server answers the renewed subscription with: everything that ran meanwhile.
		deliver({
			type: 'executionSnapshot',
			data: {
				executionId: EXECUTION_ID,
				workflowId: WORKFLOW_ID,
				status: 'running',
				flattedRunData: stringify({
					'Node A': [task(0, 'a')],
					'Node B': [task(1, 'b')],
					'Node C': [task(2, 'c')],
				}),
			},
		});
		await vi.waitFor(() => expect(output(runData()?.['Node C'])).toEqual({ value: 'c' }));
		expect(runData()?.['Node B']).toHaveLength(1);

		// The same snapshot again — a second reconnect — changes nothing.
		deliver({
			type: 'executionSnapshot',
			data: {
				executionId: EXECUTION_ID,
				workflowId: WORKFLOW_ID,
				status: 'running',
				flattedRunData: stringify({ 'Node B': [task(1, 'b')], 'Node C': [task(2, 'c')] }),
			},
		});
		await nextTick();
		expect(runData()?.['Node B']).toHaveLength(1);
		expect(runData()?.['Node C']).toHaveLength(1);
	});

	it('shows the execution as parked and running again as it waits and resumes', async () => {
		await open();
		deliver({
			type: 'nodeExecuteBefore',
			data: {
				executionId: EXECUTION_ID,
				nodeName: 'Node B',
				sequenceNumber: 0,
				data: { startTime: 2, executionIndex: 1, source: [] },
			},
		});
		await vi.waitFor(() =>
			expect(stateStore().executionRunningByNodeId.get('node-b')?.value).toBe(true),
		);

		deliver({ type: 'executionWaiting', data: { executionId: EXECUTION_ID } });
		await vi.waitFor(() => expect(dataStore().execution?.status).toBe('waiting'));
		expect(stateStore().executionRunningByNodeId.get('node-b')?.value).toBe(false);

		deliver({
			type: 'executionStarted',
			data: {
				executionId: EXECUTION_ID,
				workflowId: WORKFLOW_ID,
				mode: 'webhook',
				startedAt: new Date(),
				flattedRunData: '[{}]',
			},
		});
		await vi.waitFor(() => expect(dataStore().execution?.status).toBe('running'));
		// The resume carries no data for a watcher; what it showed before stays.
		expect(runData()?.['Node A']).toHaveLength(1);
	});

	it('ends on the stored result and releases the subscription when the execution finishes', async () => {
		await open();
		const finished = execution({
			status: 'success',
			finished: true,
			data: {
				resultData: {
					runData: { 'Node A': [task(0, 'a')], 'Node B': [task(1, 'b')], 'Node C': [task(2, 'c')] },
					lastNodeExecuted: 'Node C',
				},
			} as never,
		});
		workflowsStore.fetchExecutionDataById = vi.fn().mockResolvedValue(finished);
		sent.length = 0;

		deliver({
			type: 'executionFinished',
			data: { executionId: EXECUTION_ID, workflowId: WORKFLOW_ID, status: 'success' },
		});

		await vi.waitFor(() => expect(dataStore().execution?.status).toBe('success'));
		expect(output(runData()?.['Node C'])).toEqual({ value: 'c' });
		expect(sent).toEqual([{ type: 'unsubscribeFromExecution', executionId: EXECUTION_ID }]);
		expect(useExecutionWatchStore().documentsWatching(EXECUTION_ID)).toEqual([]);
	});

	it('ignores the events of an execution it does not display', async () => {
		await open();

		deliver({
			type: 'nodeExecuteBefore',
			data: {
				executionId: 'another',
				nodeName: 'Node B',
				sequenceNumber: 0,
				data: { startTime: 2, executionIndex: 1, source: [] },
			},
		});
		await nextTick();

		expect(stateStore().executionRunningByNodeId.get('node-b')?.value).toBe(false);
	});

	it('releases the subscription when the preview goes away', async () => {
		const preview = await open();
		sent.length = 0;

		preview.dispose();

		expect(sent).toEqual([{ type: 'unsubscribeFromExecution', executionId: EXECUTION_ID }]);
		expect(useExecutionWatchStore().documentsWatching(EXECUTION_ID)).toEqual([]);
	});

	it('does not subscribe to an execution that already ended', async () => {
		workflowsStore.getExecution = vi
			.fn()
			.mockResolvedValue(execution({ status: 'success', finished: true }));

		await open();

		expect(sent).toEqual([]);
	});
});
