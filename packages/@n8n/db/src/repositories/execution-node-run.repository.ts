import { DataSource, LessThanOrEqual, Repository } from '@n8n/typeorm';
import type { QueryDeepPartialEntity } from '@n8n/typeorm/query-builder/QueryPartialEntity';
import { Service } from '@n8n/di';

import { ExecutionNodeRun } from '../entities/execution-node-run';

@Service()
export class ExecutionNodeRunRepository extends Repository<ExecutionNodeRun> {
	constructor(dataSource: DataSource) {
		super(ExecutionNodeRun, dataSource.manager);
	}

	/**
	 * Appends node runs to an execution's journal.
	 *
	 * `orIgnore` makes a retry of the same batch a no-op rather than a constraint failure:
	 * the journal is written from a lifecycle hook, which may run again after a transient
	 * database error, and a duplicate `(executionId, seq)` carries the same task anyway.
	 */
	async append(rows: ExecutionNodeRun[]): Promise<void> {
		if (rows.length === 0) return;

		await this.createQueryBuilder()
			.insert()
			.into(ExecutionNodeRun)
			.values(rows as QueryDeepPartialEntity<ExecutionNodeRun>[])
			.orIgnore()
			.execute();
	}

	/** The journal of an execution, oldest first. */
	async findByExecution(executionId: string): Promise<ExecutionNodeRun[]> {
		return await this.find({ where: { executionId }, order: { seq: 'ASC' } });
	}

	/** Highest position used so far, so a resumed run continues the same order. */
	async findHighestSeq(executionId: string): Promise<number> {
		const latest = await this.findOne({
			where: { executionId },
			order: { seq: 'DESC' },
			select: ['seq'],
		});

		return latest?.seq ?? 0;
	}

	/**
	 * Drops the journal of an execution up to the point a snapshot now covers.
	 *
	 * Bounded by `seq` rather than truncating the whole execution: a resume that has
	 * already appended past the snapshot keeps those rows, so a crash right after the
	 * snapshot still accounts for them.
	 */
	async deleteUpTo(executionId: string, seq: number): Promise<void> {
		await this.delete({ executionId, seq: LessThanOrEqual(seq) });
	}
}
