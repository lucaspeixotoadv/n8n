import { createPinia, setActivePinia } from 'pinia';
import { nextTick, ref } from 'vue';

import { createWorkflowDocumentId } from '@/app/stores/workflowDocument.store';
import { usePushConnectionStore } from '@/app/stores/pushConnection.store';
import { useExecutionWatchStore } from '@/features/execution/executions/executionWatch.store';

const { watchExecution, unwatchExecution } = vi.hoisted(() => ({
	watchExecution: vi.fn<(context: unknown, executionId: string) => Promise<void>>(),
	unwatchExecution: vi.fn<(context: unknown, executionId: string) => Promise<void>>(),
}));

vi.mock('@/features/execution/executions/executionWatch.api', () => ({
	watchExecution,
	unwatchExecution,
}));

describe('executionWatch.store', () => {
	const documentA = createWorkflowDocumentId('wf-a');
	const documentB = createWorkflowDocumentId('wf-b');

	let store: ReturnType<typeof useExecutionWatchStore>;
	const isConnected = ref(true);

	/** What reached the server, in order. */
	const requests = () => [
		...watchExecution.mock.calls.map(([, id]) => `watch ${id}`),
		...unwatchExecution.mock.calls.map(([, id]) => `unwatch ${id}`),
	];

	/** Lets the chained requests reach the mocked server. */
	const settle = async () => await new Promise((resolve) => setTimeout(resolve, 0));

	beforeEach(() => {
		vi.clearAllMocks();
		watchExecution.mockResolvedValue();
		unwatchExecution.mockResolvedValue();
		isConnected.value = true;
		setActivePinia(createPinia());
		vi.spyOn(usePushConnectionStore(), 'isConnected', 'get').mockImplementation(
			() => isConnected.value,
		);
		store = useExecutionWatchStore();
	});

	it('asks the server for the execution a document starts observing', async () => {
		store.observe(documentA, 'exec-1');

		expect(store.documentsWatching('exec-1')).toEqual([documentA]);
		expect(store.observedExecution(documentA)).toBe('exec-1');
		await settle();
		expect(watchExecution).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'exec-1');
	});

	it('asks again for a second document, so each observation starts with a snapshot', async () => {
		store.observe(documentA, 'exec-1');
		store.observe(documentB, 'exec-1');

		await settle();
		expect(watchExecution).toHaveBeenCalledTimes(2);
		expect(store.documentsWatching('exec-1')).toEqual([documentA, documentB]);
	});

	it('does nothing when a document observes what it already observes', async () => {
		store.observe(documentA, 'exec-1');
		store.observe(documentA, 'exec-1');

		await settle();
		expect(watchExecution).toHaveBeenCalledOnce();
	});

	it('replaces the execution a document observes in one step', async () => {
		store.observe(documentA, 'exec-1');
		store.observe(documentA, 'exec-2');

		// The registry answers for the new execution and no longer for the old one, before
		// any request has resolved.
		expect(store.documentsWatching('exec-1')).toEqual([]);
		expect(store.documentsWatching('exec-2')).toEqual([documentA]);
		expect(store.observedExecution(documentA)).toBe('exec-2');
		await settle();
		expect(unwatchExecution).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'exec-1');
		expect(watchExecution).toHaveBeenLastCalledWith(expect.anything(), 'exec-2');
	});

	it('keeps the subscription while another document still observes', async () => {
		store.observe(documentA, 'exec-1');
		store.observe(documentB, 'exec-1');

		store.observe(documentA, null);

		await settle();
		expect(unwatchExecution).not.toHaveBeenCalled();
		expect(store.documentsWatching('exec-1')).toEqual([documentB]);
	});

	it('releases the subscription when the last document stops observing', async () => {
		store.observe(documentA, 'exec-1');

		store.observe(documentA, null);

		await settle();
		expect(unwatchExecution).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'exec-1');
		expect(store.documentsWatching('exec-1')).toEqual([]);
		expect(store.observedExecution(documentA)).toBeUndefined();
	});

	it('ignores a document that stops observing nothing', async () => {
		store.observe(documentA, null);

		await settle();
		expect(unwatchExecution).not.toHaveBeenCalled();
	});

	it('reports no documents for an execution nothing observes', () => {
		expect(store.documentsWatching('exec-1')).toEqual([]);
	});

	it('sends the requests for one execution in the order they were decided', async () => {
		// The first request is slow; the ones decided after it must still reach the server
		// after it, or the server ends up with the opposite of what the session decided.
		let finishFirst: () => void = () => {};
		watchExecution.mockImplementationOnce(
			async () => await new Promise<void>((resolve) => (finishFirst = resolve)),
		);
		const order: string[] = [];
		unwatchExecution.mockImplementation(async (_, id) => {
			order.push(`unwatch ${id}`);
		});
		watchExecution.mockImplementation(async (_, id) => {
			order.push(`watch ${id}`);
		});

		store.observe(documentA, 'exec-1');
		store.observe(documentA, null);
		store.observe(documentA, 'exec-1');
		await nextTick();
		expect(order).toEqual([]);

		finishFirst();
		await vi.waitFor(() => expect(order).toEqual(['unwatch exec-1', 'watch exec-1']));
	});

	it('waits for the connection before asking, and asks for everything once it is up', async () => {
		isConnected.value = false;
		store.observe(documentA, 'exec-1');
		store.observe(documentB, 'exec-2');
		await settle();
		expect(watchExecution).not.toHaveBeenCalled();

		isConnected.value = true;
		await nextTick();

		await vi.waitFor(() => expect(requests()).toEqual(['watch exec-1', 'watch exec-2']));
	});

	it('renews every subscription when the connection comes back, once each', async () => {
		// The server forgets a session's subscriptions with its connection, and every renewed
		// one starts with a fresh snapshot: that is how a document catches up.
		store.observe(documentA, 'exec-1');
		store.observe(documentB, 'exec-2');
		await settle();
		vi.clearAllMocks();

		isConnected.value = false;
		await nextTick();
		expect(watchExecution).not.toHaveBeenCalled();

		isConnected.value = true;
		await nextTick();

		await vi.waitFor(() => expect(requests()).toEqual(['watch exec-1', 'watch exec-2']));
	});

	it('does not renew a subscription a document released before the reconnect', async () => {
		store.observe(documentA, 'exec-1');
		store.observe(documentA, null);
		await settle();
		vi.clearAllMocks();

		isConnected.value = false;
		await nextTick();
		isConnected.value = true;
		await nextTick();

		await settle();
		expect(watchExecution).not.toHaveBeenCalled();
	});

	it('does not release on the server what the lost connection already released', async () => {
		store.observe(documentA, 'exec-1');
		await settle();
		isConnected.value = false;
		await nextTick();

		store.observe(documentA, null);

		await settle();
		expect(unwatchExecution).not.toHaveBeenCalled();
	});

	it('keeps observing when a request fails, so the next reconnect asks again', async () => {
		vi.spyOn(console, 'warn').mockImplementation(() => {});
		watchExecution.mockRejectedValueOnce(new Error('network'));

		store.observe(documentA, 'exec-1');
		await settle();

		expect(store.documentsWatching('exec-1')).toEqual([documentA]);

		isConnected.value = false;
		await nextTick();
		isConnected.value = true;
		await nextTick();

		await vi.waitFor(() => expect(watchExecution).toHaveBeenCalledTimes(2));
	});
});
