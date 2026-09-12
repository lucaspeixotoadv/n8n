import { defineStore } from 'pinia';
import { readonly, ref, watch, type WatchStopHandle } from 'vue';

import { usePushConnectionStore } from '@/app/stores/pushConnection.store';
import type { WorkflowDocumentId } from '@/app/stores/workflowDocument.store';

/**
 * Which documents display which executions, and the server-side subscription behind them.
 *
 * Execution events used to reach only the session that started the run, so an execution
 * opened from the list — started by a trigger, by a colleague, or in another tab — stayed
 * frozen at whatever the server had stored. A document that displays a still-running
 * execution registers here: the store asks the server for that execution's events once,
 * and the push handlers use the registry to find every document an event belongs to.
 *
 * Every subscription starts with a snapshot from the server — what the execution has done
 * so far, on the same channel as the events that follow — so nothing falls between the
 * state a document loaded and the stream it then follows. The server drops a session's
 * subscriptions when its connection goes away, so a reconnect re-sends them all, and each
 * renewed subscription brings a fresh snapshot: that is how a document catches up on what
 * it missed while it was disconnected, without a second mechanism.
 */
export const useExecutionWatchStore = defineStore('executionWatch', () => {
	const documentsByExecution = ref(new Map<string, Set<WorkflowDocumentId>>());

	/**
	 * Set up on the first watch, not at store creation: the push handlers read this
	 * registry on every execution event, and reading it must never open a push
	 * connection for a session that watches nothing.
	 */
	let stopReconnectWatcher: WatchStopHandle | null = null;

	function subscribe(executionId: string) {
		usePushConnectionStore().send({ type: 'subscribeToExecution', executionId });
	}

	/** Starts showing live events for an execution in this document. */
	function watchExecution(executionId: string, documentId: WorkflowDocumentId) {
		const documents = documentsByExecution.value.get(executionId);

		if (documents) {
			documents.add(documentId);
			return;
		}

		documentsByExecution.value.set(executionId, new Set([documentId]));
		subscribe(executionId);
		watchReconnects();
	}

	/** Stops showing live events for an execution in this document. */
	function unwatchExecution(executionId: string, documentId: WorkflowDocumentId) {
		const documents = documentsByExecution.value.get(executionId);
		if (!documents) return;

		documents.delete(documentId);
		if (documents.size > 0) return;

		documentsByExecution.value.delete(executionId);
		usePushConnectionStore().send({ type: 'unsubscribeFromExecution', executionId });
	}

	/** The documents displaying this execution, for the push handlers to update. */
	function documentsWatching(executionId: string): WorkflowDocumentId[] {
		return [...(documentsByExecution.value.get(executionId) ?? [])];
	}

	function watchReconnects() {
		if (stopReconnectWatcher !== null) return;

		const pushStore = usePushConnectionStore();
		stopReconnectWatcher = watch(
			() => pushStore.isConnected,
			(isConnected) => {
				if (!isConnected) return;

				for (const executionId of documentsByExecution.value.keys()) {
					subscribe(executionId);
				}
			},
		);
	}

	return {
		/**
		 * The registry itself, for readers that resolve documents on every execution event.
		 * State rather than a call, so it answers even where store actions are stubbed.
		 */
		documentsByExecution: readonly(documentsByExecution),
		watchExecution,
		unwatchExecution,
		documentsWatching,
	};
});
