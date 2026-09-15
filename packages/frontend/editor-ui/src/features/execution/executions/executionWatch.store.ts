import { defineStore } from 'pinia';
import { readonly, ref, watch, type WatchStopHandle } from 'vue';
import { useRootStore } from '@n8n/stores/useRootStore';

import { usePushConnectionStore } from '@/app/stores/pushConnection.store';
import type { WorkflowDocumentId } from '@/app/stores/workflowDocument.store';
import {
	unwatchExecution,
	watchExecution,
} from '@/features/execution/executions/executionWatch.api';

/**
 * Which documents observe which executions, and the server-side subscription behind them.
 *
 * Execution events reach only the session that started the run unless the session asks for
 * them, so an execution opened from a list — started by a trigger, by a colleague, or in
 * another tab — would stay frozen at whatever the server had stored. A document that
 * displays an execution which can still produce events registers here, and the push
 * handlers use the registry to find every document an event belongs to.
 *
 * A document observes at most one execution: the one it displays. `observe` replaces the
 * previous one in a single step, so there is never a moment where a document is registered
 * for an execution it no longer shows, and never one where the execution it shows is not
 * registered.
 *
 * Every observation starts with a snapshot from the server — what the execution has done so
 * far, on the same channel as the events that follow — so nothing falls between the state a
 * document loaded and the stream it then follows. That holds for a second document joining
 * an execution the session already receives, which is why the server is asked once per
 * document, not once per execution. The server drops a session's subscriptions when its
 * connection goes away, so a reconnect asks for them all again, and each renewed
 * subscription brings a fresh snapshot: that is how a document catches up on what it missed
 * while it was disconnected, without a second mechanism.
 */
export const useExecutionWatchStore = defineStore('executionWatch', () => {
	const documentsByExecution = ref(new Map<string, Set<WorkflowDocumentId>>());
	const executionByDocument = new Map<WorkflowDocumentId, string>();

	/**
	 * Executions the server has been asked for since the connection last came up. A
	 * connection that drops takes the server's registrations with it, so nothing is left
	 * to release for these until they are asked for again.
	 */
	const requested = new Set<string>();

	/**
	 * Requests in flight per execution. Chained so that a subscribe and an unsubscribe
	 * decided in one order reach the server in that order, whatever their latencies.
	 */
	const inFlight = new Map<string, Promise<void>>();

	/**
	 * Set up on the first observation, not at store creation: the push handlers read this
	 * registry on every execution event, and reading it must never open a push connection
	 * for a session that observes nothing.
	 */
	let stopConnectionWatcher: WatchStopHandle | null = null;

	function enqueue(executionId: string, request: () => Promise<void>) {
		const previous = inFlight.get(executionId) ?? Promise.resolve();
		const next = previous.then(request).catch((error: unknown) => {
			// The connection watcher asks again on the next reconnect; until then the stored
			// execution still completes the picture when the run ends.
			console.warn('[executionWatch] Could not update an execution subscription', error);
		});
		inFlight.set(executionId, next);
		void next.finally(() => {
			if (inFlight.get(executionId) === next) inFlight.delete(executionId);
		});
	}

	/** Asks the server for the execution's events, if the session is connected to hear them. */
	function request(executionId: string) {
		if (!usePushConnectionStore().isConnected) return;

		requested.add(executionId);
		const context = useRootStore().restApiContext;
		enqueue(executionId, async () => await watchExecution(context, executionId));
	}

	function release(executionId: string) {
		if (!requested.delete(executionId)) return;

		const context = useRootStore().restApiContext;
		enqueue(executionId, async () => await unwatchExecution(context, executionId));
	}

	/**
	 * Makes `executionId` the execution this document observes, or none.
	 *
	 * The document is registered for the new execution before the server is asked, so an
	 * event that arrives ahead of the snapshot is not dropped for want of a document.
	 */
	function observe(documentId: WorkflowDocumentId, executionId: string | null) {
		const previous = executionByDocument.get(documentId);
		if (previous === (executionId ?? undefined)) return;

		if (previous !== undefined) {
			executionByDocument.delete(documentId);
			const documents = documentsByExecution.value.get(previous);
			documents?.delete(documentId);
			if (documents?.size === 0) {
				documentsByExecution.value.delete(previous);
				release(previous);
			}
		}

		if (executionId === null) return;

		executionByDocument.set(documentId, executionId);
		const documents = documentsByExecution.value.get(executionId);
		if (documents) {
			documents.add(documentId);
		} else {
			documentsByExecution.value.set(executionId, new Set([documentId]));
		}
		request(executionId);
		watchConnection();
	}

	/** The documents displaying this execution, for the push handlers to update. */
	function documentsWatching(executionId: string): WorkflowDocumentId[] {
		return [...(documentsByExecution.value.get(executionId) ?? [])];
	}

	/** The execution this document observes, if any. */
	function observedExecution(documentId: WorkflowDocumentId): string | undefined {
		return executionByDocument.get(documentId);
	}

	function watchConnection() {
		if (stopConnectionWatcher !== null) return;

		const pushStore = usePushConnectionStore();
		stopConnectionWatcher = watch(
			() => pushStore.isConnected,
			(isConnected) => {
				if (!isConnected) {
					requested.clear();
					return;
				}

				for (const executionId of documentsByExecution.value.keys()) {
					request(executionId);
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
		observe,
		documentsWatching,
		observedExecution,
	};
});
