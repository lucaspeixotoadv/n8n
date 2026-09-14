import { createTestingPinia } from '@pinia/testing';
import { setActivePinia } from 'pinia';
import { stringify } from 'flatted';
import { mock } from 'vitest-mock-extended';
import { nextTick, ref } from 'vue';
import type { Router } from 'vue-router';
import type { PushMessage } from '@n8n/api-types';
import type { ExecutionStatus, ITaskData, ITaskStartedData } from 'n8n-workflow';
import { STORES } from '@n8n/stores';
import { createTestNode, createTestWorkflow } from '@/__tests__/mocks';
import { mockedStore } from '@/__tests__/utils';
import type { IWorkflowDb } from '@/Interface';
import type { IExecutionResponse } from '@/features/execution/executions/executions.types';
import { useWorkflowsStore } from '@/app/stores/workflows.store';
import { usePushConnectionStore } from '@/app/stores/pushConnection.store';
import { usePushConnection } from '@/app/composables/usePushConnection';
import {
	createExecutionPreviewDocumentId,
	createWorkflowDocumentId,
	useWorkflowDocumentStore,
} from '@/app/stores/workflowDocument.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useExecutionWatchStore } from '@/features/execution/executions/executionWatch.store';
import { useExecutionPreviewDocument } from '@/features/execution/executions/composables/useExecutionPreviewDocument';
import { IN_PROGRESS_EXECUTION_ID } from '@/app/constants/placeholders';

const { watchExecution, unwatchExecution } = vi.hoisted(() => ({
	watchExecution: vi.fn<(context: unknown, executionId: string) => Promise<void>>(),
	unwatchExecution: vi.fn<(context: unknown, executionId: string) => Promise<void>>(),
}));
vi.mock('@/features/execution/executions/executionWatch.api', () => ({
	watchExecution,
	unwatchExecution,
}));
vi.mock('@n8n/composables/useToast', () => ({
	useToast: () => ({
		showMessage: vi.fn(),
		showError: vi.fn(),
		clearAllStickyNotifications: vi.fn(),
	}),
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

const started = (executionIndex: number): ITaskStartedData => ({
	startTime: executionIndex,
	executionIndex,
	source: [],
});

/** The first output item of a node's run, as displayed. */
const output = (runs: readonly unknown[] | undefined, index = 0) =>
	(runs?.[index] as ITaskData | undefined)?.data?.main[0]?.[0]?.json;

function execution(id: string, overrides: Partial<IExecutionResponse> = {}): IExecutionResponse {
	return {
		id,
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
 * The whole client side of observing an execution, as it runs in the app: a document shows
 * an execution, the execution-state store derives the subscription from that, the push
 * pipeline routes every event through the same handlers a manual run in the editor goes
 * through, and the document's own stores are what the canvas renders.
 *
 * The preview document stands in for every way of opening an execution from a list — the
 * global list, the workflow's sidebar, a direct URL, a reload, back and forward — since all
 * of them end in the same host loading the execution into the same stores. What differs
 * between them is only whether that host is created or reused, which is what the switching
 * scenarios cover.
 */
describe('observing a running execution', () => {
	const previewDocumentId = createExecutionPreviewDocumentId(WORKFLOW_ID, VERSION_ID);
	const editorDocumentId = createWorkflowDocumentId(WORKFLOW_ID);
	let workflowsStore: ReturnType<typeof mockedStore<typeof useWorkflowsStore>>;
	let pushStore: ReturnType<typeof usePushConnectionStore>;
	const isConnected = ref(true);
	/** Executions as the server has them, by id. */
	let stored: Map<string, IExecutionResponse>;

	/** Delivers a server message the way the connection does. */
	function deliver(message: PushMessage) {
		for (const handler of pushStore.onMessageReceivedHandlers) handler(message);
	}

	/** What the session asked the server for, in order. */
	const requests: string[] = [];
	/** Lets chained requests reach the mocked server and handlers settle. */
	const settle = async () => await new Promise((resolve) => setTimeout(resolve, 0));

	const stateStore = (documentId = previewDocumentId) => useWorkflowExecutionStateStore(documentId);
	const dataStore = (executionId: string) =>
		useExecutionDataStore(createExecutionDataId(executionId));
	const runData = (executionId: string) =>
		dataStore(executionId).execution?.data?.resultData.runData;
	const running = (nodeId: string, documentId = previewDocumentId) =>
		stateStore(documentId).executionRunningByNodeId.get(nodeId)?.value;
	const watching = (executionId: string) => useExecutionWatchStore().documentsWatching(executionId);

	const nodeStarted = (
		executionId: string,
		nodeName: string,
		executionIndex: number,
	): PushMessage => ({
		type: 'nodeExecuteBefore',
		data: {
			executionId,
			nodeName,
			sequenceNumber: executionIndex * 2,
			data: started(executionIndex),
		},
	});
	const nodeFinished = (
		executionId: string,
		nodeName: string,
		executionIndex: number,
	): PushMessage => ({
		type: 'nodeExecuteAfter',
		data: {
			executionId,
			nodeName,
			sequenceNumber: executionIndex * 2 + 1,
			itemCountByConnectionType: { main: [1] },
			data: {
				startTime: executionIndex,
				executionTime: 1,
				executionIndex,
				source: [],
				executionStatus: 'success',
			},
		},
	});
	const nodeData = (
		executionId: string,
		nodeName: string,
		executionIndex: number,
		value: unknown,
	): PushMessage => ({
		type: 'nodeExecuteAfterData',
		data: {
			executionId,
			nodeName,
			itemCountByConnectionType: { main: [1] },
			data: task(executionIndex, value),
		},
	});
	const snapshot = (
		executionId: string,
		status: ExecutionStatus,
		data: Partial<Extract<PushMessage, { type: 'executionSnapshot' }>['data']> = {},
	): PushMessage => ({
		type: 'executionSnapshot',
		data: { executionId, workflowId: WORKFLOW_ID, status, ...data },
	});
	const finished = (executionId: string, status: ExecutionStatus = 'success'): PushMessage => ({
		type: 'executionFinished',
		data: { executionId, workflowId: WORKFLOW_ID, status },
	});

	/** Marks an execution as ended on the server, as the finish handler will read it. */
	function endOnServer(executionId: string, status: ExecutionStatus = 'success') {
		stored.set(
			executionId,
			execution(executionId, {
				status,
				finished: status === 'success',
				data: {
					resultData: {
						runData: {
							'Node A': [task(0, 'a')],
							'Node B': [task(1, 'b')],
							'Node C': [task(2, 'c')],
						},
						lastNodeExecuted: 'Node C',
					},
				} as never,
			}),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
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
		stored = new Map([['42', execution('42')]]);
		workflowsStore = mockedStore(useWorkflowsStore);
		workflowsStore.getExecution = vi.fn(async (id: string) => stored.get(id));
		workflowsStore.fetchExecutionDataById = vi.fn(async (id: string) => stored.get(id));
		pushStore = usePushConnectionStore();
		requests.length = 0;
		watchExecution.mockImplementation(async (_, id) => {
			requests.push(`watch ${id}`);
		});
		unwatchExecution.mockImplementation(async (_, id) => {
			requests.push(`unwatch ${id}`);
		});
		isConnected.value = true;
		vi.spyOn(pushStore, 'isConnected', 'get').mockImplementation(() => isConnected.value);
		// The editor document, as the workflow layout loads it.
		useWorkflowDocumentStore(editorDocumentId).hydrate(execution('42').workflowData as IWorkflowDb);
		usePushConnection({ router: mock<Router>() }).initialize();
	});

	async function open(executionId = '42') {
		const current = ref(executionId);
		const preview = useExecutionPreviewDocument({ executionId: () => current.value });
		await preview.load();
		await settle();
		return {
			preview,
			async switchTo(id: string) {
				current.value = id;
				await preview.load();
				await settle();
			},
			/** Starts a switch and hands back control before the execution is loaded. */
			startSwitchTo(id: string) {
				current.value = id;
				const loading = preview.load();
				return async () => {
					await loading;
					await settle();
				};
			},
		};
	}

	describe('opening', () => {
		it('subscribes once, shows what the execution did, and follows what it does next', async () => {
			await open();

			expect(requests).toEqual(['watch 42']);
			expect(watching('42')).toEqual([previewDocumentId]);
			expect(stateStore().activeExecutionStatusByNodeId.get('node-a')?.value).toBe('success');
			expect(stateStore().activeExecutionStatusByNodeId.get('node-b')?.value).toBe('new');

			deliver(nodeStarted('42', 'Node B', 1));
			await vi.waitFor(() => expect(running('node-b')).toBe(true));

			deliver(nodeFinished('42', 'Node B', 1));
			await vi.waitFor(() => expect(running('node-b')).toBe(false));
			expect(stateStore().activeExecutionStatusByNodeId.get('node-b')?.value).toBe('success');

			deliver(nodeData('42', 'Node B', 1, 'b'));
			await vi.waitFor(() => expect(output(runData('42')?.['Node B'])).toEqual({ value: 'b' }));
		});

		it('shows the node the execution is on when it was already running before it was opened', async () => {
			await open();

			deliver(
				snapshot('42', 'running', {
					executingNodes: [{ nodeName: 'Node B', sequenceNumber: 2, data: started(1) }],
				}),
			);
			await vi.waitFor(() => expect(running('node-b')).toBe(true));
			expect(dataStore('42').executionStartedData?.[1]).toEqual({ 'Node B': [started(1)] });

			// The node finishing is what ends it, exactly as for a start the session saw itself.
			deliver(nodeFinished('42', 'Node B', 1));
			await vi.waitFor(() => expect(running('node-b')).toBe(false));
		});

		it('reconciles the snapshot the subscription answers with, without losing what came first', async () => {
			await open();
			// A node that finished after the subscription was registered but before the server
			// built the snapshot: its events arrive first, and the snapshot does not know it.
			deliver(nodeFinished('42', 'Node C', 2));
			deliver(nodeData('42', 'Node C', 2, 'c'));
			await vi.waitFor(() => expect(output(runData('42')?.['Node C'])).toEqual({ value: 'c' }));

			deliver(
				snapshot('42', 'running', {
					flattedRunData: stringify({ 'Node A': [task(0, 'a')], 'Node B': [task(1, 'b')] }),
				}),
			);

			await vi.waitFor(() => expect(output(runData('42')?.['Node B'])).toEqual({ value: 'b' }));
			expect(output(runData('42')?.['Node C'])).toEqual({ value: 'c' });
			expect(runData('42')?.['Node A']).toHaveLength(1);
		});

		it('does not subscribe to an execution that already ended', async () => {
			stored.set('42', execution('42', { status: 'success', finished: true }));

			await open();

			expect(requests).toEqual([]);
			expect(watching('42')).toEqual([]);
		});

		it('subscribes to a queued execution and follows it once it starts', async () => {
			stored.set(
				'42',
				execution('42', { status: 'new', data: { resultData: { runData: {} } } as never }),
			);
			await open();
			expect(requests).toEqual(['watch 42']);

			deliver({
				type: 'executionStarted',
				data: {
					executionId: '42',
					workflowId: WORKFLOW_ID,
					mode: 'webhook',
					startedAt: new Date(),
					flattedRunData: '[{}]',
				},
			});
			await vi.waitFor(() => expect(dataStore('42').execution?.status).toBe('running'));

			deliver(nodeStarted('42', 'Node A', 0));
			await vi.waitFor(() => expect(running('node-a')).toBe(true));
		});

		it('is the same whichever way the execution is shown: a document showing a running execution follows it', async () => {
			// What the debug route and a hand-off do: display an execution in the editor document.
			stateStore(editorDocumentId).setWorkflowExecutionData(execution('42'));
			await settle();

			expect(requests).toEqual(['watch 42']);
			deliver(nodeStarted('42', 'Node B', 1));
			await vi.waitFor(() => expect(running('node-b', editorDocumentId)).toBe(true));
		});
	});

	describe('switching', () => {
		beforeEach(() => {
			stored.set('43', execution('43'));
			stored.set('44', execution('44'));
		});

		it('releases the previous execution and follows the next one from a clean slate', async () => {
			const view = await open('42');
			deliver(nodeStarted('42', 'Node B', 30));
			await vi.waitFor(() => expect(running('node-b')).toBe(true));
			requests.length = 0;

			await view.switchTo('43');

			expect(requests).toEqual(['unwatch 42', 'watch 43']);
			expect(watching('42')).toEqual([]);
			expect(watching('43')).toEqual([previewDocumentId]);
			// The node the previous execution was on is not shown for this one.
			expect(running('node-b')).toBe(false);
			// The new execution's first events are accepted although their numbers restart.
			deliver(nodeStarted('43', 'Node C', 1));
			await vi.waitFor(() => expect(running('node-c')).toBe(true));
			expect(stateStore().displayedExecutionId).toBe('43');
		});

		it('drops events of the previous execution that were still in transit', async () => {
			const view = await open('42');
			await view.switchTo('43');

			deliver(nodeStarted('42', 'Node B', 40));
			deliver(nodeFinished('42', 'Node B', 40));
			deliver(nodeData('42', 'Node B', 40, 'late'));
			await settle();

			expect(running('node-b')).toBe(false);
			expect(runData('42')?.['Node B']).toBeUndefined();
			expect(stateStore().displayedExecutionId).toBe('43');
		});

		it('ends on the last of rapid switches, and discards the responses of the ones in between', async () => {
			const view = await open('42');
			requests.length = 0;
			let answer43: (value: IExecutionResponse) => void = () => {};
			workflowsStore.getExecution = vi.fn(async (id: string) =>
				id === '43'
					? await new Promise<IExecutionResponse>((resolve) => (answer43 = resolve))
					: stored.get(id),
			);

			const finish43 = view.startSwitchTo('43');
			const finish44 = view.startSwitchTo('44');
			await finish44();
			// The slow response for the execution the user already left arrives last.
			answer43(execution('43'));
			await finish43();

			expect(stateStore().displayedExecutionId).toBe('44');
			expect(watching('43')).toEqual([]);
			expect(watching('44')).toEqual([previewDocumentId]);
			expect(requests).toEqual(['unwatch 42', 'watch 44']);
		});

		it('follows an execution again when the user comes back to it', async () => {
			const view = await open('42');
			await view.switchTo('43');
			requests.length = 0;

			await view.switchTo('42');

			// Still running, so it is read again rather than shown from memory, and observed again.
			expect(workflowsStore.getExecution).toHaveBeenLastCalledWith('42');
			expect(requests).toEqual(['unwatch 43', 'watch 42']);
			deliver(nodeStarted('42', 'Node C', 2));
			await vi.waitFor(() => expect(running('node-c')).toBe(true));
		});

		it('keeps showing the next execution when the previous one finishes during the switch', async () => {
			const view = await open('42');
			let answer43: (value: IExecutionResponse) => void = () => {};
			workflowsStore.getExecution = vi.fn(async (id: string) =>
				id === '43'
					? await new Promise<IExecutionResponse>((resolve) => (answer43 = resolve))
					: stored.get(id),
			);
			let answerFinish: (value: IExecutionResponse | undefined) => void = () => {};
			workflowsStore.fetchExecutionDataById = vi.fn(
				async () =>
					await new Promise<IExecutionResponse | undefined>((resolve) => (answerFinish = resolve)),
			);

			const finish43 = view.startSwitchTo('43');
			await nextTick();
			// Still subscribed to 42 while 43 loads: its finish lands now.
			endOnServer('42');
			deliver(finished('42'));
			await nextTick();
			answer43(execution('43'));
			await finish43();
			expect(stateStore().displayedExecutionId).toBe('43');

			answerFinish(stored.get('42'));
			await settle();

			expect(stateStore().displayedExecutionId).toBe('43');
			expect(watching('43')).toEqual([previewDocumentId]);
			expect(watching('42')).toEqual([]);
			// The finished execution's own data is still complete for whenever it is shown again.
			expect(dataStore('42').execution?.status).toBe('success');
			expect(output(runData('42')?.['Node C'])).toEqual({ value: 'c' });
		});

		it('settles an execution that ended between being read and being subscribed to', async () => {
			await open('42');
			endOnServer('42', 'error');

			// What the server answers a subscription to an execution that has just ended with.
			deliver(snapshot('42', 'error'));

			await vi.waitFor(() => expect(dataStore('42').execution?.status).toBe('error'));
			expect(output(runData('42')?.['Node C'])).toEqual({ value: 'c' });
			await vi.waitFor(() => expect(requests).toEqual(['watch 42', 'unwatch 42']));
			expect(watching('42')).toEqual([]);
		});
	});

	describe('ending', () => {
		it('ends on the stored result and releases the subscription when the execution finishes', async () => {
			await open();
			deliver(nodeStarted('42', 'Node C', 2));
			await vi.waitFor(() => expect(running('node-c')).toBe(true));
			endOnServer('42');

			deliver(finished('42'));

			await vi.waitFor(() => expect(dataStore('42').execution?.status).toBe('success'));
			expect(output(runData('42')?.['Node C'])).toEqual({ value: 'c' });
			expect(running('node-c')).toBe(false);
			await vi.waitFor(() => expect(requests).toEqual(['watch 42', 'unwatch 42']));
			expect(watching('42')).toEqual([]);
		});

		it('releases the subscription when the view goes away', async () => {
			const { preview } = await open();

			preview.dispose();
			await settle();

			expect(requests).toEqual(['watch 42', 'unwatch 42']);
			expect(watching('42')).toEqual([]);
		});

		it('ignores the events of an execution it does not display', async () => {
			await open();

			deliver(nodeStarted('another', 'Node B', 1));
			await nextTick();

			expect(running('node-b')).toBe(false);
		});
	});

	describe('the connection', () => {
		it('catches up through a renewed subscription after the connection was lost', async () => {
			await open();
			requests.length = 0;

			isConnected.value = false;
			await nextTick();
			isConnected.value = true;
			await nextTick();
			await settle();

			expect(requests).toEqual(['watch 42']);

			// What the server answers the renewed subscription with: everything that ran meanwhile.
			deliver(
				snapshot('42', 'running', {
					flattedRunData: stringify({
						'Node A': [task(0, 'a')],
						'Node B': [task(1, 'b')],
						'Node C': [task(2, 'c')],
					}),
					executingNodes: [{ nodeName: 'Node C', sequenceNumber: 6, data: started(3) }],
				}),
			);
			await vi.waitFor(() => expect(output(runData('42')?.['Node C'])).toEqual({ value: 'c' }));
			expect(runData('42')?.['Node B']).toHaveLength(1);
			expect(running('node-c')).toBe(true);

			// The same snapshot again — a second reconnect — changes nothing.
			deliver(
				snapshot('42', 'running', {
					flattedRunData: stringify({ 'Node B': [task(1, 'b')], 'Node C': [task(2, 'c')] }),
				}),
			);
			await nextTick();
			expect(runData('42')?.['Node B']).toHaveLength(1);
			expect(runData('42')?.['Node C']).toHaveLength(1);
		});

		it('asks only once when opened while the connection is still coming up', async () => {
			isConnected.value = false;
			await open();
			expect(requests).toEqual([]);

			isConnected.value = true;
			await nextTick();
			await settle();

			expect(requests).toEqual(['watch 42']);
		});
	});

	describe('a parked execution', () => {
		it('shows the execution as parked and running again as it waits and resumes', async () => {
			await open();
			deliver(nodeStarted('42', 'Node B', 1));
			await vi.waitFor(() => expect(running('node-b')).toBe(true));

			deliver({ type: 'executionWaiting', data: { executionId: '42' } });
			await vi.waitFor(() => expect(dataStore('42').execution?.status).toBe('waiting'));
			expect(running('node-b')).toBe(false);
			// Parked, not ended: the subscription stays for the resume.
			expect(watching('42')).toEqual([previewDocumentId]);

			deliver({
				type: 'executionStarted',
				data: {
					executionId: '42',
					workflowId: WORKFLOW_ID,
					mode: 'webhook',
					startedAt: new Date(),
					flattedRunData: stringify({ 'Node A': [task(0, 'a')], 'Node B': [task(1, 'b')] }),
				},
			});
			await vi.waitFor(() => expect(dataStore('42').execution?.status).toBe('running'));
			expect(output(runData('42')?.['Node B'])).toEqual({ value: 'b' });
			// The resumed segment restarts its numbering, and is accepted.
			deliver(nodeStarted('42', 'Node C', 2));
			await vi.waitFor(() => expect(running('node-c')).toBe(true));
		});
	});

	describe('a run started in the editor', () => {
		const editor = () => stateStore(editorDocumentId);

		async function runInEditor(executionId = '42') {
			editor().setWorkflowExecutionData(
				execution(IN_PROGRESS_EXECUTION_ID, { data: { resultData: { runData: {} } } as never }),
			);
			deliver({
				type: 'executionStarted',
				data: {
					executionId,
					workflowId: WORKFLOW_ID,
					mode: 'manual',
					startedAt: new Date(),
					flattedRunData: '[{}]',
				},
			});
			await vi.waitFor(() => expect(editor().activeExecutionId).toBe(executionId));
			await settle();
		}

		it('is followed by the editor as its owner, and observed so a lost connection can be caught up on', async () => {
			await runInEditor();

			expect(requests).toEqual(['watch 42']);
			deliver(nodeStarted('42', 'Node A', 0));
			await vi.waitFor(() => expect(running('node-a', editorDocumentId)).toBe(true));

			endOnServer('42');
			deliver(finished('42'));
			await vi.waitFor(() => expect(editor().activeExecutionId).toBeUndefined());
			await vi.waitFor(() => expect(requests).toEqual(['watch 42', 'unwatch 42']));
		});

		it('is shown live in the executions view too while the editor still owns it', async () => {
			await runInEditor();
			requests.length = 0;

			await open('42');

			// A second document starts with its own snapshot; the subscription itself is shared.
			expect(requests).toEqual(['watch 42']);
			expect(watching('42')).toEqual(expect.arrayContaining([editorDocumentId, previewDocumentId]));

			deliver(nodeStarted('42', 'Node B', 1));
			await vi.waitFor(() => expect(running('node-b')).toBe(true));
			expect(running('node-b', editorDocumentId)).toBe(true);

			endOnServer('42');
			deliver(finished('42'));
			await vi.waitFor(() => expect(editor().activeExecutionId).toBeUndefined());
			await vi.waitFor(() => expect(dataStore('42').execution?.status).toBe('success'));
			expect(running('node-b')).toBe(false);
			await vi.waitFor(() => expect(watching('42')).toEqual([]));
			expect(requests).toEqual(['watch 42', 'unwatch 42']);
		});

		it('is observed like any other execution when reopened after the editor let it go', async () => {
			await runInEditor();
			// Leaving the editor for another part of the app resets its execution state.
			editor().resetExecutionState();
			await settle();
			expect(requests).toEqual(['watch 42', 'unwatch 42']);
			requests.length = 0;

			await open('42');

			expect(requests).toEqual(['watch 42']);
			expect(watching('42')).toEqual([previewDocumentId]);
			deliver(nodeStarted('42', 'Node B', 1));
			await vi.waitFor(() => expect(running('node-b')).toBe(true));
			// Not the owner any more: the finish is the stored result, nothing else.
			endOnServer('42');
			deliver(finished('42'));
			await vi.waitFor(() => expect(dataStore('42').execution?.status).toBe('success'));
			expect(editor().activeExecutionId).toBeUndefined();
		});

		it('is caught up on by the owner too when its finish was missed', async () => {
			await runInEditor();
			endOnServer('42');

			// The connection dropped and came back: the renewed subscription answers with the end.
			deliver(snapshot('42', 'success'));

			await vi.waitFor(() => expect(editor().activeExecutionId).toBeUndefined());
			expect(dataStore('42').execution?.status).toBe('success');
			expect(output(runData('42')?.['Node C'])).toEqual({ value: 'c' });
		});
	});
});
