import { Logger } from '@n8n/backend-common';
import { ExecutionNodeRun, ExecutionNodeRunRepository } from '@n8n/db';
import { Container, Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import type { IRunExecutionData, ITaskData } from 'n8n-workflow';

import { ExecutionJournalConfig } from './execution-journal.config';

/** Stands in for a task too large to journal; the consolidated save still carries it. */
const OVERSIZED_TASK_PLACEHOLDER = { journalTruncated: true } as const;

/**
 * Records node runs as they happen, so an execution's progress is readable before it ends.
 *
 * An execution's `data` is a snapshot written when the run finishes. Everything between the
 * first node and that moment is invisible in the database, which is why a run that is
 * cancelled, crashes or loses its worker can read as if nothing had happened. This journal
 * closes the gap without turning every node into a rewrite of the whole execution, which is
 * what made the existing progress-saving option too expensive to leave on.
 *
 * Whether a run is journalled at all is the workflow's decision, resolved in `toSaveSettings`
 * and applied where the hooks are built — this service records what it is handed.
 *
 * Journalling never fails an execution: a run whose progress could not be recorded is still
 * a run, and the consolidated save remains the authoritative record.
 */
@Service()
export class ExecutionJournalService {
	/** Next position per execution, seeded from the journal so a resume continues its order. */
	private readonly nextSeq = new Map<string, number>();

	constructor(
		private readonly logger: Logger,
		private readonly config: ExecutionJournalConfig,
	) {
		this.logger = this.logger.scoped('execution-journal');
	}

	/**
	 * Resolved on use rather than injected: lifecycle hooks are built for every run, and on
	 * paths that never journal anything — a disabled journal, a harness with no database —
	 * constructing the repository would reach for a connection that need not exist.
	 */
	private get repository(): ExecutionNodeRunRepository {
		return Container.get(ExecutionNodeRunRepository);
	}

	async recordNodeRun(
		executionId: string,
		nodeName: string,
		taskData: ITaskData,
		executionData: IRunExecutionData,
	): Promise<void> {
		try {
			const row = new ExecutionNodeRun();
			row.executionId = executionId;
			row.seq = await this.claimSeq(executionId);
			row.nodeName = nodeName;
			row.runIndex = this.resolveRunIndex(executionData, nodeName, taskData);
			row.taskData = this.withinSizeLimit(taskData)
				? taskData
				: ({ ...taskData, data: OVERSIZED_TASK_PLACEHOLDER } as unknown as ITaskData);
			row.createdAt = new Date();

			await this.repository.append([row]);
		} catch (error) {
			this.logger.warn('Could not journal a node run', {
				executionId,
				nodeName,
				error: ensureError(error).message,
			});
		}
	}

	/** Releases the journal an execution no longer needs, once its snapshot covers it. */
	async forget(executionId: string): Promise<void> {
		const highest = this.nextSeq.get(executionId);
		this.nextSeq.delete(executionId);

		try {
			await this.repository.deleteUpTo(executionId, (highest ?? 1) - 1);
		} catch (error) {
			this.logger.warn('Could not release the journal of an execution', {
				executionId,
				error: ensureError(error).message,
			});
		}
	}

	/**
	 * The next position for this execution.
	 *
	 * Seeded from the journal on first use so a resumed run continues the order rather than
	 * restarting it — a consumer comparing positions must never see them go backwards.
	 */
	private async claimSeq(executionId: string): Promise<number> {
		const known = this.nextSeq.get(executionId);
		if (known !== undefined) {
			this.nextSeq.set(executionId, known + 1);
			return known;
		}

		const seq = (await this.repository.findHighestSeq(executionId)) + 1;
		this.nextSeq.set(executionId, seq + 1);
		return seq;
	}

	/**
	 * Where this task sits among the node's runs, as the engine has recorded them.
	 *
	 * A run the engine merged into a placeholder — every agent tool call, and a node resumed
	 * from a wait — is not the object handed to the hook, so identity is tried first and
	 * `executionIndex` with `startTime` second: the merge copies both onto the placeholder,
	 * and a placeholder that is still empty carries zeros a real run never has. Only then
	 * fall back to the last run, which is right for a node that simply appended.
	 */
	private resolveRunIndex(
		executionData: IRunExecutionData,
		nodeName: string,
		taskData: ITaskData,
	): number {
		const runs = executionData.resultData.runData[nodeName];
		if (!runs) return 0;

		const byIdentity = runs.lastIndexOf(taskData);
		if (byIdentity !== -1) return byIdentity;

		const byPosition = runs.findIndex(
			(run) =>
				run.executionIndex === taskData.executionIndex && run.startTime === taskData.startTime,
		);
		if (byPosition !== -1) return byPosition;

		return Math.max(runs.length - 1, 0);
	}

	private withinSizeLimit(taskData: ITaskData): boolean {
		try {
			return Buffer.byteLength(JSON.stringify(taskData)) <= this.config.maxTaskBytes;
		} catch {
			// Unserializable task data cannot be journalled either way.
			return false;
		}
	}
}
