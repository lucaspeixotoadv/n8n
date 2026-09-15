import { Column, Entity, Index } from '@n8n/typeorm';
import type { IDataObject } from 'n8n-workflow';

import { DateTimeColumn, JsonColumn, WithTimestampsAndStringId } from '@n8n/db';

/**
 * Lifecycle of a single callback correlation row.
 *
 * - `pendingCallback`: a callback arrived before any tool call registered a wait for its
 *   key. The payload is parked here so the callback is not lost.
 * - `waiting`: a tool call registered a wait and its execution is (or is about to be)
 *   parked. This is the only state a callback can wake.
 * - `resuming`: exactly one worker won the `waiting -> resuming` transition and owns the
 *   resume. Later deliveries of the same event see this state and no-op.
 * - `completed`: the wait is resolved (or was abandoned because its execution is gone).
 *   The row is kept on purpose so a repeated delivery is recognised as a duplicate
 *   instead of being archived as a new early callback.
 */
export const CALLBACK_WAIT_STATUSES = [
	'pendingCallback',
	'waiting',
	'resuming',
	'completed',
] as const;

export type CallbackWaitStatus = (typeof CALLBACK_WAIT_STATUSES)[number];

/** The states in which a row still owns its correlation key. */
export const LIVE_CALLBACK_WAIT_STATUSES: CallbackWaitStatus[] = [
	'pendingCallback',
	'waiting',
	'resuming',
];

/**
 * One correlation between an external HTTP callback and a suspended AI tool call.
 *
 * Identity is `(namespace, correlationValue)`, where the namespace is the id of the
 * webhook registration that received the callback. The same external id delivered to two
 * different tools is therefore two different waits.
 *
 * `activeKey` carries that identity only while the row is live, and is `NULL` once the row
 * is `completed`. A partial unique index over the non-null values is what makes "at most
 * one live wait per key" a schema invariant rather than a check in application code, while
 * still allowing the resolved history to accumulate under the same key.
 */
@Entity()
export class CallbackWait extends WithTimestampsAndStringId {
	/** Webhook registration that owns the endpoint the callback is delivered to. */
	@Index()
	@Column({ type: 'varchar', length: 36 })
	namespace: string;

	/** Correlation id, normalised to its string form (`125` and `"125"` are one value). */
	@Column({ type: 'varchar', length: 255 })
	correlationValue: string;

	/**
	 * `namespace:correlationValue` while the row is live, `NULL` once it is completed.
	 * Never read it as data — it exists to carry the uniqueness constraint.
	 */
	@Column({ type: 'varchar', length: 292, nullable: true })
	activeKey: string | null;

	@Column({ type: 'varchar', length: 32 })
	status: CallbackWaitStatus;

	/** The suspended execution, `NULL` while the row is only a parked early callback. */
	@Index()
	@Column({ type: 'varchar', length: 36, nullable: true })
	executionId: string | null;

	/** The tool call this wait belongs to, for traceability across a resume. */
	@Column({ type: 'varchar', length: 255, nullable: true })
	toolCallId: string | null;

	/** Id of the tool node that registered the wait, re-checked before a resume. */
	@Column({ type: 'varchar', length: 36, nullable: true })
	nodeId: string | null;

	@Column({ type: 'varchar', length: 36, nullable: true })
	workflowId: string | null;

	/** The user the parked run was started as, so the resume runs as the same user. */
	@Column({ type: 'varchar', length: 36, nullable: true })
	userId: string | null;

	/** The callback body, and only the body — headers and query never reach the agent. */
	@JsonColumn({ nullable: true })
	payload: IDataObject | null;

	/** When the callback body landed, whether or not a wait existed at that moment. */
	@DateTimeColumn({ nullable: true })
	payloadReceivedAt: Date | null;

	@DateTimeColumn({ nullable: true })
	resolvedAt: Date | null;
}
