import { createPinia, setActivePinia } from 'pinia';
import type { Mock } from 'vitest';
import { nextTick, ref } from 'vue';

import { createWorkflowDocumentId } from '@/app/stores/workflowDocument.store';
import { usePushConnectionStore } from '@/app/stores/pushConnection.store';
import { useExecutionWatchStore } from '@/features/execution/executions/executionWatch.store';

describe('executionWatch.store', () => {
	const documentA = createWorkflowDocumentId('wf-a');
	const documentB = createWorkflowDocumentId('wf-b');

	let store: ReturnType<typeof useExecutionWatchStore>;
	let send: Mock<(message: unknown) => void>;

	beforeEach(() => {
		setActivePinia(createPinia());
		store = useExecutionWatchStore();
		send = vi.fn<(message: unknown) => void>();
		vi.spyOn(usePushConnectionStore(), 'send').mockImplementation(send);
	});

	it('asks the server for an execution the first time a document watches it', () => {
		store.watchExecution('exec-1', documentA);

		expect(send).toHaveBeenCalledExactlyOnceWith({
			type: 'subscribeToExecution',
			executionId: 'exec-1',
		});
		expect(store.documentsWatching('exec-1')).toEqual([documentA]);
	});

	it('does not ask twice for an execution two documents watch', () => {
		store.watchExecution('exec-1', documentA);
		store.watchExecution('exec-1', documentB);

		expect(send).toHaveBeenCalledOnce();
		expect(store.documentsWatching('exec-1')).toEqual([documentA, documentB]);
	});

	it('keeps the subscription while another document still watches', () => {
		store.watchExecution('exec-1', documentA);
		store.watchExecution('exec-1', documentB);
		send.mockClear();

		store.unwatchExecution('exec-1', documentA);

		expect(send).not.toHaveBeenCalled();
		expect(store.documentsWatching('exec-1')).toEqual([documentB]);
	});

	it('releases the subscription when the last document stops watching', () => {
		store.watchExecution('exec-1', documentA);
		send.mockClear();

		store.unwatchExecution('exec-1', documentA);

		expect(send).toHaveBeenCalledExactlyOnceWith({
			type: 'unsubscribeFromExecution',
			executionId: 'exec-1',
		});
		expect(store.documentsWatching('exec-1')).toEqual([]);
	});

	it('ignores an unwatch for an execution nothing watches', () => {
		store.unwatchExecution('exec-1', documentA);

		expect(send).not.toHaveBeenCalled();
	});

	it('reports no documents for an execution nothing watches', () => {
		expect(store.documentsWatching('exec-1')).toEqual([]);
	});

	it('renews every subscription when the connection comes back', async () => {
		// The server forgets a session's subscriptions with its connection, and every renewed
		// one starts with a fresh snapshot: that is how a document catches up.
		const isConnected = ref(true);
		vi.spyOn(usePushConnectionStore(), 'isConnected', 'get').mockImplementation(
			() => isConnected.value,
		);
		store.watchExecution('exec-1', documentA);
		store.watchExecution('exec-2', documentB);
		send.mockClear();

		isConnected.value = false;
		await nextTick();
		expect(send).not.toHaveBeenCalled();

		isConnected.value = true;
		await nextTick();

		expect(send.mock.calls.map(([message]) => message)).toEqual([
			{ type: 'subscribeToExecution', executionId: 'exec-1' },
			{ type: 'subscribeToExecution', executionId: 'exec-2' },
		]);
	});

	it('does not renew a subscription a document released before the reconnect', async () => {
		const isConnected = ref(true);
		vi.spyOn(usePushConnectionStore(), 'isConnected', 'get').mockImplementation(
			() => isConnected.value,
		);
		store.watchExecution('exec-1', documentA);
		store.unwatchExecution('exec-1', documentA);
		send.mockClear();

		isConnected.value = false;
		await nextTick();
		isConnected.value = true;
		await nextTick();

		expect(send).not.toHaveBeenCalled();
	});
});
