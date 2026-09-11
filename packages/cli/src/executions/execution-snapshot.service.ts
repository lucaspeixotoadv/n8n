import type { ExecutionNodeRun, IExecutionResponse } from '@n8n/db';
import { ExecutionNodeRunRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { isTerminalExecutionStatus, type IRunData } from 'n8n-workflow';

/**
 * Completes an execution's persisted state with the runs recorded since its last snapshot.
 *
 * An execution's `data` is written when the run ends, so reading one that is still going —
 * `new`, `running` or `waiting` — shows the state as of its last save, which for most runs
 * is the moment it started. Merging the journal makes a single read answer the same
 * question for every status: what has this execution done so far.
 *
 * Terminal executions are returned untouched. Their snapshot is already complete, and their
 * journal has been released, so there is nothing to merge and no query worth making.
 */
@Service()
export class ExecutionSnapshotService {
	constructor(private readonly nodeRunRepository: ExecutionNodeRunRepository) {}

	async complete(execution: IExecutionResponse): Promise<IExecutionResponse> {
		if (isTerminalExecutionStatus(execution.status)) return execution;

		const journal = await this.nodeRunRepository.findByExecution(execution.id);
		if (journal.length === 0) return execution;

		const runData = mergeJournal(execution.data.resultData.runData, journal);

		return {
			...execution,
			data: {
				...execution.data,
				resultData: {
					...execution.data.resultData,
					runData,
					lastNodeExecuted:
						journal[journal.length - 1].nodeName ?? execution.data.resultData.lastNodeExecuted,
				},
			},
		};
	}
}

/**
 * Folds journalled runs into the snapshot's run data.
 *
 * A journalled run replaces the snapshot's entry at the same position rather than being
 * appended: the two overlap whenever progress was saved, and the journalled copy is the
 * one that was recorded as the node finished.
 */
function mergeJournal(runData: IRunData, journal: ExecutionNodeRun[]): IRunData {
	const merged: IRunData = { ...runData };

	for (const { nodeName, runIndex, taskData } of journal) {
		const runs = merged[nodeName] ? [...merged[nodeName]] : [];
		runs[runIndex] = taskData;
		merged[nodeName] = runs;
	}

	return merged;
}
