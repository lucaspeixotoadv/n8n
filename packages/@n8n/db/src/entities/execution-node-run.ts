import { Column, Entity, Index, PrimaryColumn } from '@n8n/typeorm';
import type { ITaskData, ITaskStartedData } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn } from './abstract-entity';
import { idStringifier } from '../utils/transformers';

/** Whether a row records a node run that started or one that finished. */
export type ExecutionNodeRunKind = 'started' | 'finished';

/**
 * One node event, appended the moment it happened: a node run starting, or one finishing.
 *
 * The execution's own `data` is a snapshot written when the run ends, so until then the
 * database says nothing about how far the run got. This table is the journal that closes
 * that gap: opening a running execution shows real progress, including the node it is on
 * right now, and a run that dies without reaching its final save — a crash, a lost worker —
 * still accounts for what it did.
 *
 * It is deliberately not an archive. Rows are dropped as soon as the consolidated snapshot
 * lands, so they only ever cover executions that are still in flight.
 */
@Entity()
@Index(['executionId', 'seq'])
export class ExecutionNodeRun {
	/** Stored as the integer `execution_entity.id`; carried as a string, as everywhere else. */
	@PrimaryColumn({ transformer: idStringifier })
	executionId: string;

	/**
	 * Position in this execution's node-event order, monotonic across resumes.
	 *
	 * A consumer streaming events alongside the snapshot uses it to tell what it has
	 * already seen: an event at or below the snapshot's highest `seq` is a replay, and a
	 * gap means the stream is behind and the snapshot has to be re-read.
	 */
	@PrimaryColumn({ type: 'integer' })
	seq: number;

	/**
	 * A `started` row is written as the node begins and carries the task as started; a
	 * `finished` row is written as it ends and carries the task as recorded. A started row
	 * with no finished row for the same task is a node that is running right now.
	 */
	@Column({ type: 'varchar', length: 16, default: 'finished' })
	kind: ExecutionNodeRunKind;

	@Column({ type: 'varchar', length: 255 })
	nodeName: string;

	/** Where the finished run sits among the node's runs; unknown while the run is going. */
	@Column({ type: 'integer', nullable: true })
	runIndex: number | null;

	/**
	 * The task as started or as recorded, by `kind`, or a placeholder when a finished task
	 * exceeded the journalling size limit.
	 */
	@JsonColumn()
	taskData: ITaskData | ITaskStartedData;

	@DateTimeColumn()
	createdAt: Date;
}
