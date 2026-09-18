import { Logger } from '@n8n/backend-common';
import { TransactionRunner, type OperationContext } from '@n8n/db';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import type {
	CallbackWaitProvider,
	CallbackWaitRegistration,
	CallbackWaitRegistrationResult,
	IDataObject,
} from 'n8n-workflow';

import { CallbackWaitConfig } from './callback-wait.config';
import type { CallbackWait } from './callback-wait.entity';
import { CallbackWaitRepository } from './callback-wait.repository';
import { CallbackWaitCollisionError } from './errors/callback-wait-collision.error';

/** Why an early callback was not parked. */
export type CallbackDropReason = 'tooManyParked' | 'bodyTooLarge';

/** What a delivered callback resolved to, from the correlator's point of view. */
export type CallbackCorrelationOutcome =
	/** The delivery won the race for a parked wait and now owns its resume. */
	| { kind: 'claimed'; wait: CallbackWait; payload: IDataObject }
	/** Nothing was waiting, so the body is parked until a wait registers for the key. */
	| { kind: 'parked' }
	/**
	 * The key was consumed before this delivery: by a concurrent delivery that won the
	 * claim, by a resume already in flight, by a resolved wait, or by a parked body.
	 * The winner's payload is untouched.
	 */
	| { kind: 'duplicate' }
	/** Nothing was waiting and the body could not be parked either. */
	| { kind: 'dropped'; reason: CallbackDropReason };

/**
 * Owns the correlation between external callbacks and parked tool calls.
 *
 * Every state change here is a conditional write on one row, which is what makes the whole
 * feature idempotent: repeated deliveries of the same event differ in their envelopes and
 * timestamps, so the only trustworthy source of "has this been handled" is whether a
 * process won the atomic transition on the correlation key.
 */
@Service()
export class CallbackWaitService implements CallbackWaitProvider {
	constructor(
		private readonly logger: Logger,
		private readonly repository: CallbackWaitRepository,
		private readonly transactionRunner: TransactionRunner,
		private readonly config: CallbackWaitConfig,
	) {
		this.logger = this.logger.scoped('waiting-executions');
	}

	/**
	 * Registers a wait, or consumes the callback that already arrived for its key.
	 *
	 * Check and insert share one transaction so the tool call and a concurrent delivery
	 * cannot both conclude they got there first. The database keeps the invariant even if
	 * this code is wrong: the partial unique index rejects a second live row for a key.
	 *
	 * That index is also what elects the execution a callback belongs to when several ask
	 * for the same key: the registration the database commits first holds it, and every
	 * later one fails here with {@link CallbackWaitCollisionError}, before it parks. The
	 * order is the commit order the database serialised, not a timestamp comparison, so
	 * there is no tie to break and nothing depends on the order rows come back in.
	 */
	async registerWait(
		registration: CallbackWaitRegistration,
	): Promise<CallbackWaitRegistrationResult> {
		const { namespace, correlationValue } = registration;
		const claim = {
			executionId: registration.executionId,
			toolCallId: registration.toolCallId ?? null,
			nodeId: registration.nodeId,
			workflowId: registration.workflowId ?? null,
			userId: registration.userId ?? null,
		};

		try {
			return await this.transactionRunner.run({}, async (ctx) => {
				const live = await this.repository.findLive(ctx, namespace, correlationValue);

				if (live?.status === 'pendingCallback') {
					const claimed = await this.repository.claimEarlyCallback(ctx, live.id, claim);
					if (claimed) return { status: 'resolved', payload: live.payload ?? {} };

					// Another registration consumed the parked body first. Its claim is committed,
					// or the conditional update would have matched, so the row now names it.
					const consumer = await this.repository.findLatest(ctx, namespace, correlationValue);
					throw this.collisionError(correlationValue, consumer);
				}

				// A live row that is not a parked callback is another tool call already waiting on
				// this key. Refusing loudly is the only safe answer: the callback resolves at most
				// one wait, so a second one would park forever with no way to be woken.
				if (live) throw this.collisionError(correlationValue, live);

				await this.repository.insertWait(ctx, namespace, correlationValue, claim);

				return { status: 'registered' };
			});
		} catch (error) {
			if (error instanceof CallbackWaitCollisionError) throw error;

			// Two registrations can both find the key free and both insert. The unique index
			// lets only one row in; the other insert fails, and by then the winner's row is
			// there to be named. A failure that left no row behind is not a collision.
			const holder =
				(await this.repository.findLive({}, namespace, correlationValue)) ??
				(await this.repository.findLatest({}, namespace, correlationValue));
			if (holder) throw this.collisionError(correlationValue, holder, ensureError(error));

			throw error;
		}
	}

	/**
	 * Applies a delivered callback to the correlation key.
	 *
	 * The caller has already authenticated the request and extracted the identifier; this
	 * decides, atomically, whether the delivery wakes anything.
	 */
	async correlate(
		namespace: string,
		correlationValue: string,
		payload: IDataObject,
	): Promise<CallbackCorrelationOutcome> {
		try {
			return await this.transactionRunner.run({}, async (ctx) => {
				const live = await this.repository.findLive(ctx, namespace, correlationValue);

				if (live?.status === 'waiting') {
					const record = { payload, payloadReceivedAt: new Date() };
					// The one write that decides the race: a conditional update on the row's
					// status. The database serialises it, so of any number of concurrent
					// deliveries exactly one sees its row matched — and only that one's payload
					// is written. Reading `waiting` a moment ago proves nothing.
					const claimed = await this.repository.claimForResume(ctx, live.id, record);
					if (!claimed) return { kind: 'duplicate' };

					return { kind: 'claimed', wait: Object.assign(live, record), payload };
				}

				// Already resuming, or a second delivery landing on a parked callback.
				if (live) return { kind: 'duplicate' };

				// No live row. A resolved row for the same key means this is a late duplicate,
				// which must not be re-parked: a future wait for the key would otherwise wake with
				// the residue of a correlation that is already finished.
				const latest = await this.repository.findLatest(ctx, namespace, correlationValue);
				if (latest) return { kind: 'duplicate' };

				return await this.park(ctx, namespace, correlationValue, payload);
			});
		} catch (error) {
			// Two first deliveries of one event can both find nothing and both try to park.
			// The unique index lets only one row in; the other insert fails. That failure is
			// a duplicate, not a fault, but only if a row for the key does exist now.
			const latest = await this.repository.findLatest({}, namespace, correlationValue);
			if (latest) return { kind: 'duplicate' };

			throw error;
		}
	}

	/** Confirms a claimed delivery as delivered, releasing the correlation key. */
	async markResolved(waitId: string): Promise<void> {
		await this.repository.markCompleted({}, waitId);
	}

	/**
	 * Returns a claimed delivery to `waiting` when the resume could not be started, so a
	 * later delivery, or the deferred hand-off, can still resolve the tool call.
	 */
	async releaseClaim(waitId: string): Promise<void> {
		await this.repository.releaseResumeClaim({}, waitId);
	}

	/** Deliveries whose payload landed before the execution had finished parking. */
	async findUndelivered(executionId: string): Promise<CallbackWait[]> {
		return await this.repository.findUndeliveredForExecution({}, executionId);
	}

	/** Every claimed delivery not yet confirmed, whichever execution it belongs to. */
	async findAllUndelivered(): Promise<CallbackWait[]> {
		return await this.repository.findAllUndelivered({});
	}

	/**
	 * Releases the correlation keys an execution still holds, once it will never resume.
	 * Its resolved rows stay, so a late duplicate is still recognised until retention.
	 */
	async forgetExecution(executionId: string): Promise<void> {
		await this.repository.deleteForExecution({}, executionId);
	}

	/**
	 * Parks a callback whose wait has not registered yet.
	 *
	 * This is the one write on this table driven purely by external traffic, so it is the
	 * one that needs bounding: a per-namespace ceiling stops an endpoint from being used as
	 * unbounded storage, and the row is dropped again by retention.
	 */
	private async park(
		ctx: OperationContext,
		namespace: string,
		correlationValue: string,
		payload: IDataObject,
	): Promise<CallbackCorrelationOutcome> {
		const parked = await this.repository.countEarlyCallbacks(ctx, namespace);
		if (parked >= this.config.maxEarlyCallbacksPerNamespace) {
			this.logger.warn('Dropping an early callback: the endpoint holds too many already', {
				namespace,
				parked,
			});
			return { kind: 'dropped', reason: 'tooManyParked' };
		}

		if (!this.isWithinSizeLimit(payload)) {
			this.logger.warn('Dropping an early callback: the body exceeds the stored size limit', {
				namespace,
			});
			return { kind: 'dropped', reason: 'bodyTooLarge' };
		}

		await this.repository.insertEarlyCallback(ctx, namespace, correlationValue, {
			payload,
			payloadReceivedAt: new Date(),
		});

		return { kind: 'parked' };
	}

	private isWithinSizeLimit(payload: IDataObject): boolean {
		return Buffer.byteLength(JSON.stringify(payload)) <= this.config.maxCallbackBodyBytes;
	}

	/**
	 * The refusal a registration gets for a key another execution holds. The holder is the
	 * row that owns the key; a row with no execution is a parked callback nobody has
	 * consumed yet, which cannot collide, so the error then names no holder.
	 */
	private collisionError(correlationValue: string, holder: CallbackWait | null, cause?: Error) {
		return new CallbackWaitCollisionError(
			correlationValue,
			holder?.executionId ? { executionId: holder.executionId, since: holder.createdAt } : null,
			cause,
		);
	}
}
