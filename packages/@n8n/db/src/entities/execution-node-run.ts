import { Column, Entity, Index, PrimaryColumn } from '@n8n/typeorm';
import type { ITaskData } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn } from './abstract-entity';

/**
 * One node run, appended the moment it finished.
 *
 * The execution's own `data` is a snapshot written when the run ends, so until then the
 * database says nothing about how far the run got. This table is the journal that closes
 * that gap: opening a running execution shows real progress, and a run that dies without
 * reaching its final save — a crash, a lost worker — still accounts for what it did.
 *
 * It is deliberately not an archive. Rows are dropped as soon as the consolidated snapshot
 * lands, so they only ever cover executions that are still in flight.
 */
@Entity()
@Index(['executionId', 'seq'])
export class ExecutionNodeRun {
	@PrimaryColumn({ type: 'varchar', length: 36 })
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

	@Column({ type: 'varchar', length: 255 })
	nodeName: string;

	@Column({ type: 'integer' })
	runIndex: number;

	/** The task as recorded, or a placeholder when it exceeded the journalling size limit. */
	@JsonColumn()
	taskData: ITaskData;

	@DateTimeColumn()
	createdAt: Date;
}
