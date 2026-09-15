import type { ExecutionSnapshot } from '@n8n/api-types/push/execution';
import { parse } from 'flatted';
import { isTerminalExecutionStatus } from 'n8n-workflow';
import type { IRunData } from 'n8n-workflow';
import { createExecutionDataId, useExecutionDataStore } from '@/app/stores/executionData.store';
import { useWorkflowExecutionStateStore } from '@/app/stores/workflowExecutionState.store';
import { executionFinished, refreshWatchingDocuments } from './executionFinished';
import { allExecutionDocuments, resolveExecutionDocuments } from './executionDocuments';
import type { PushHandlerOptions } from './types';

/**
 * Handles the 'executionSnapshot' event: what an execution has done so far and what it is
 * doing now, sent when a session subscribes to it.
 *
 * The session already holds the execution as it read it over HTTP, and may already have
 * applied events that reached it after the subscription was registered but before the
 * snapshot was built. So the snapshot is merged, run by run, over what is displayed: a run
 * it brings is added or refreshed, and a run it does not know is kept. Applied the same
 * way after a lost connection, this is how the session catches up without losing what it
 * saw or showing anything twice.
 *
 * The node shown as executing is not merged but replaced: the snapshot names the node the
 * execution is on, and a node the session showed as executing that the snapshot does not
 * name has finished meanwhile, so what the session showed is simply stale.
 */
export async function executionSnapshot({ data }: ExecutionSnapshot, options: PushHandlerOptions) {
	const documents = resolveExecutionDocuments(data.executionId, options);
	const documentIds = allExecutionDocuments(documents);
	if (documentIds.length === 0) {
		return;
	}

	const executionDataStore = useExecutionDataStore(createExecutionDataId(data.executionId));
	const displayed = executionDataStore.getExecutionSnapshot();
	// Nothing displayed yet to complete: the read that follows carries the same state.
	if (displayed === null) {
		return;
	}

	// The execution ended while the session was not listening, so no finish event will
	// come: treat the snapshot as the finish, which reads the stored execution in full and,
	// for the document that started the run, settles it the way the finish would have.
	if (isTerminalExecutionStatus(data.status)) {
		if (documents.ownerDocumentId !== null) {
			await executionFinished(
				{
					type: 'executionFinished',
					data: { executionId: data.executionId, workflowId: data.workflowId, status: data.status },
				},
				options,
			);
		} else {
			await refreshWatchingDocuments(data.executionId, documents.watcherDocumentIds);
		}
		return;
	}

	if (data.flattedRunData !== undefined) {
		executionDataStore.mergeExecutionRunData(parse(data.flattedRunData) as IRunData);
	}

	if (displayed.status !== data.status) {
		executionDataStore.setExecution(
			{ ...executionDataStore.getExecutionSnapshot(), status: data.status } as never,
			{ stripWaitingTaskData: false },
		);
	}

	const executingNodes = data.executingNodes ?? [];
	for (const node of executingNodes) {
		executionDataStore.addNodeExecutionStartedData({
			executionId: data.executionId,
			nodeName: node.nodeName,
			sequenceNumber: node.sequenceNumber,
			data: node.data,
		});
	}

	// The latest node to start is the one shown; the others are on the stack behind it.
	const current = executingNodes.reduce<(typeof executingNodes)[number] | undefined>(
		(latest, node) =>
			latest === undefined || node.sequenceNumber > latest.sequenceNumber ? node : latest,
		undefined,
	);
	for (const documentId of documentIds) {
		const { executingNode } = useWorkflowExecutionStateStore(documentId);
		executingNode.clearNodeExecutionQueue();
		if (current !== undefined) {
			executingNode.addExecutingNode(current.nodeName, current.sequenceNumber);
		}
	}
}
