import type { ExecutionNodeRun, IExecutionResponse } from '@n8n/db';
import { ExecutionNodeRunRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import {
	isTerminalExecutionStatus,
	type IRunData,
	type ITaskData,
	type ITaskStartedData,
} from 'n8n-workflow';

import { toSaveSettings } from '@/execution-lifecycle/to-save-settings';

/** A node run that has started and not finished, as of the journal. */
export type ExecutingNode = {
	nodeName: string;
	data: ITaskStartedData;
};

export type ExecutionProgress = {
	execution: IExecutionResponse;
	/** In the order they started; empty for an execution that is not on a node right now. */
	executingNodes: ExecutingNode[];
};

/**
 * Completes an execution's persisted state with the runs recorded since its last snapshot.
 *
 * An execution's `data` is written when the run ends, so reading one that is still going —
 * `new`, `running` or `waiting` — shows the state as of its last save, which for most runs
 * is the moment it started. Merging the journal makes a single read answer the same
 * question for every status: what has this execution done so far, and what is it doing now.
 *
 * Terminal executions are returned untouched. Their snapshot is already complete, and their
 * journal has been released, so there is nothing to merge and no query worth making. The
 * same holds for a workflow that does not journal: nothing was ever recorded for it.
 */
@Service()
export class ExecutionSnapshotService {
	constructor(private readonly nodeRunRepository: ExecutionNodeRunRepository) {}

	async complete(execution: IExecutionResponse): Promise<IExecutionResponse> {
		return (await this.progress(execution)).execution;
	}

	async progress(execution: IExecutionResponse): Promise<ExecutionProgress> {
		if (isTerminalExecutionStatus(execution.status)) return { execution, executingNodes: [] };
		// The executed workflow's own settings, not the instance's current ones: whether a
		// journal exists for this execution was decided when it ran.
		if (!toSaveSettings(execution.workflowData?.settings).liveProgress) {
			return { execution, executingNodes: [] };
		}

		const journal = await this.nodeRunRepository.findByExecution(execution.id);
		if (journal.length === 0) return { execution, executingNodes: [] };

		const finished = journal.filter(isFinishedRun);
		const runData = mergeJournal(execution.data.resultData.runData, finished);

		return {
			execution: {
				...execution,
				data: {
					...execution.data,
					resultData: {
						...execution.data.resultData,
						runData,
						lastNodeExecuted:
							finished.at(-1)?.nodeName ?? execution.data.resultData.lastNodeExecuted,
					},
				},
			},
			executingNodes: executingNodes(journal),
		};
	}
}

type FinishedRun = ExecutionNodeRun & { kind: 'finished'; taskData: ITaskData };

function isFinishedRun(row: ExecutionNodeRun): row is FinishedRun {
	return row.kind === 'finished';
}

/**
 * Folds journalled runs into the snapshot's run data.
 *
 * A journalled run replaces the snapshot's entry at the same position rather than being
 * appended: the two overlap whenever progress was saved, and the journalled copy is the
 * one that was recorded as the node finished.
 */
function mergeJournal(runData: IRunData, journal: FinishedRun[]): IRunData {
	const merged: IRunData = { ...runData };

	for (const { nodeName, runIndex, taskData } of journal) {
		const runs = merged[nodeName] ? [...merged[nodeName]] : [];
		runs[runIndex ?? runs.length] = taskData;
		merged[nodeName] = runs;
	}

	return merged;
}

/**
 * The node runs that started and have not finished.
 *
 * A task is identified by the `executionIndex` the engine gave it, which both ends of the
 * run carry, so a started row is outstanding until a finished row names the same task.
 */
function executingNodes(journal: ExecutionNodeRun[]): ExecutingNode[] {
	const finishedTasks = new Set(
		journal
			.filter((row) => row.kind === 'finished')
			.map((row) => `${row.nodeName}#${row.taskData.executionIndex}`),
	);

	return journal
		.filter(
			(row) =>
				row.kind === 'started' &&
				!finishedTasks.has(`${row.nodeName}#${row.taskData.executionIndex}`),
		)
		.map(({ nodeName, taskData }) => ({ nodeName, data: taskData }));
}
