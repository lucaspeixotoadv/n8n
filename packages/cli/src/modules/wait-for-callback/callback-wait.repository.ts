import { DataSource, In, LessThan } from '@n8n/typeorm';
import { Service } from '@n8n/di';
import type { IDataObject } from 'n8n-workflow';

import { BaseRepository, TransactionRunner, type OperationContext } from '@n8n/db';

import { CallbackWait, LIVE_CALLBACK_WAIT_STATUSES } from './callback-wait.entity';

/** Everything needed to park a callback body under a correlation key. */
export type CallbackPayloadRecord = {
	payload: IDataObject;
	payloadReceivedAt: Date;
};

/** Everything a tool call must supply to register a wait. */
export type CallbackWaitClaim = {
	executionId: string;
	toolCallId: string | null;
	nodeId: string;
	workflowId: string | null;
};

export const buildActiveKey = (namespace: string, correlationValue: string) =>
	`${namespace}:${correlationValue}`;

/**
 * Data access for callback correlation rows.
 *
 * Every state change is expressed as a conditional write, so two processes racing on the
 * same row cannot both win: the driver reports how many rows the `UPDATE` matched, and the
 * caller treats `0` as "somebody else got there first".
 */
@Service()
export class CallbackWaitRepository extends BaseRepository<CallbackWait> {
	constructor(dataSource: DataSource, transactionRunner: TransactionRunner) {
		super(CallbackWait, dataSource.manager, transactionRunner);
	}

	/** The row currently owning `(namespace, correlationValue)`, if any. */
	async findLive(
		ctx: OperationContext,
		namespace: string,
		correlationValue: string,
	): Promise<CallbackWait | null> {
		return await this.managerFor(ctx).findOneBy(CallbackWait, {
			activeKey: buildActiveKey(namespace, correlationValue),
		});
	}

	/** The most recent row for the key, live or resolved. Used to recognise duplicates. */
	async findLatest(
		ctx: OperationContext,
		namespace: string,
		correlationValue: string,
	): Promise<CallbackWait | null> {
		return await this.managerFor(ctx).findOne(CallbackWait, {
			where: { namespace, correlationValue },
			order: { createdAt: 'DESC', id: 'DESC' },
		});
	}

	async insertWait(
		ctx: OperationContext,
		namespace: string,
		correlationValue: string,
		claim: CallbackWaitClaim,
	): Promise<CallbackWait> {
		const manager = this.managerFor(ctx);
		const row = manager.create(CallbackWait, {
			namespace,
			correlationValue,
			activeKey: buildActiveKey(namespace, correlationValue),
			status: 'waiting',
			payload: null,
			payloadReceivedAt: null,
			resolvedAt: null,
			...claim,
		});

		return await manager.save(CallbackWait, row);
	}

	async insertEarlyCallback(
		ctx: OperationContext,
		namespace: string,
		correlationValue: string,
		record: CallbackPayloadRecord,
	): Promise<CallbackWait> {
		const manager = this.managerFor(ctx);
		const row = manager.create(CallbackWait, {
			namespace,
			correlationValue,
			activeKey: buildActiveKey(namespace, correlationValue),
			status: 'pendingCallback',
			executionId: null,
			toolCallId: null,
			nodeId: null,
			workflowId: null,
			resolvedAt: null,
			...record,
		});

		return await manager.save(CallbackWait, row);
	}

	/**
	 * Claims a parked early callback for a tool call that is registering its wait.
	 * Returns `true` only for the caller that moved the row out of `pendingCallback`.
	 */
	async claimEarlyCallback(
		ctx: OperationContext,
		id: string,
		claim: CallbackWaitClaim,
	): Promise<boolean> {
		const result = await this.managerFor(ctx).update(
			CallbackWait,
			{ id, status: 'pendingCallback' },
			{ ...claim, status: 'completed', activeKey: null, resolvedAt: new Date() },
		);

		return result.affected === 1;
	}

	/**
	 * The single atomic step that makes resuming idempotent: only one caller can move a
	 * row from `waiting` to `resuming`, and that caller owns the resume.
	 */
	async claimForResume(
		ctx: OperationContext,
		id: string,
		record: CallbackPayloadRecord,
	): Promise<boolean> {
		const result = await this.managerFor(ctx).update(
			CallbackWait,
			{ id, status: 'waiting' },
			{ ...record, status: 'resuming' },
		);

		return result.affected === 1;
	}

	/** Releases the key and freezes the row as the resolved history of this correlation. */
	async markCompleted(ctx: OperationContext, id: string): Promise<void> {
		await this.managerFor(ctx).update(
			CallbackWait,
			{ id },
			{ status: 'completed', activeKey: null, resolvedAt: new Date() },
		);
	}

	/** Hands the resume back when it could not be started, so a later delivery can retry. */
	async releaseResumeClaim(ctx: OperationContext, id: string): Promise<void> {
		await this.managerFor(ctx).update(
			CallbackWait,
			{ id, status: 'resuming' },
			{ status: 'waiting' },
		);
	}

	/** Rows whose payload arrived while their execution had not parked yet. */
	async findUndeliveredForExecution(
		ctx: OperationContext,
		executionId: string,
	): Promise<CallbackWait[]> {
		return await this.managerFor(ctx).findBy(CallbackWait, { executionId, status: 'resuming' });
	}

	async deleteForExecution(ctx: OperationContext, executionId: string): Promise<void> {
		await this.managerFor(ctx).delete(CallbackWait, { executionId });
	}

	/** How many rows a namespace currently holds, to cap externally driven writes. */
	async countEarlyCallbacks(ctx: OperationContext, namespace: string): Promise<number> {
		return await this.managerFor(ctx).countBy(CallbackWait, {
			namespace,
			status: 'pendingCallback',
		});
	}

	/**
	 * Drops rows past their retention window. Live rows are only swept once they are older
	 * than the (much longer) `liveOlderThan` cutoff, so an execution that is legitimately
	 * parked for a long time is never orphaned by the sweep of resolved history.
	 */
	async pruneOlderThan(
		ctx: OperationContext,
		resolvedOlderThan: Date,
		liveOlderThan: Date,
	): Promise<number> {
		const manager = this.managerFor(ctx);
		const resolved = await manager.delete(CallbackWait, {
			status: 'completed',
			createdAt: LessThan(resolvedOlderThan),
		});
		const parked = await manager.delete(CallbackWait, {
			status: 'pendingCallback',
			createdAt: LessThan(liveOlderThan),
		});

		return (resolved.affected ?? 0) + (parked.affected ?? 0);
	}

	/** Every row of a namespace that still owns its key, for diagnostics and cleanup. */
	async findAllLive(ctx: OperationContext, namespace: string): Promise<CallbackWait[]> {
		return await this.managerFor(ctx).findBy(CallbackWait, {
			namespace,
			status: In(LIVE_CALLBACK_WAIT_STATUSES),
		});
	}
}
