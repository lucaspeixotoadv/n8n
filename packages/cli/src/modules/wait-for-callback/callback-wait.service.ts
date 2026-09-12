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
import { UserError } from 'n8n-workflow';

import { CallbackWaitConfig } from './callback-wait.config';
import type { CallbackWait } from './callback-wait.entity';
import { CallbackWaitRepository } from './callback-wait.repository';

/** What a delivered callback resolved to, from the correlator's point of view. */
export type CallbackCorrelationOutcome =
	/** The delivery won the race for a parked wait and now owns its resume. */
	| { kind: 'claimed'; wait: CallbackWait; payload: IDataObject }
	/** Nothing was waiting, so the body is parked until a wait registers for the key. */
	| { kind: 'parked' }
	/** Already resolved, already resuming, or unmatched. Never says which. */
	| { kind: 'ignored' };

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
		};

		return await this.transactionRunner.run({}, async (ctx) => {
			const live = await this.repository.findLive(ctx, namespace, correlationValue);

			if (live?.status === 'pendingCallback') {
				const claimed = await this.repository.claimEarlyCallback(ctx, live.id, claim);
				if (!claimed) throw this.duplicateWaitError(correlationValue);

				return { status: 'resolved', payload: live.payload ?? {} };
			}

			// A live row that is not a parked callback is another tool call already waiting on
			// this key. Refusing loudly is the only safe answer: the callback resolves at most
			// one wait, so a second one would park forever with no way to be woken.
			if (live) throw this.duplicateWaitError(correlationValue);

			try {
				await this.repository.insertWait(ctx, namespace, correlationValue, claim);
			} catch (error) {
				throw this.duplicateWaitError(correlationValue, ensureError(error));
			}

			return { status: 'registered' };
		});
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
		return await this.transactionRunner.run({}, async (ctx) => {
			const live = await this.repository.findLive(ctx, namespace, correlationValue);

			if (live?.status === 'waiting') {
				const record = { payload, payloadReceivedAt: new Date() };
				const claimed = await this.repository.claimForResume(ctx, live.id, record);
				// Lost the transition to a concurrent delivery of the same event.
				if (!claimed) return { kind: 'ignored' };

				return { kind: 'claimed', wait: Object.assign(live, record), payload };
			}

			// Already resuming, or a second delivery landing on a parked callback.
			if (live) return { kind: 'ignored' };

			// No live row. A resolved row for the same key means this is a late duplicate,
			// which must not be re-parked: a future wait for the key would otherwise wake with
			// the residue of a correlation that is already finished.
			const latest = await this.repository.findLatest(ctx, namespace, correlationValue);
			if (latest) return { kind: 'ignored' };

			return await this.park(ctx, namespace, correlationValue, payload);
		});
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
			return { kind: 'ignored' };
		}

		if (!this.isWithinSizeLimit(payload)) {
			this.logger.warn('Dropping an early callback: the body exceeds the stored size limit', {
				namespace,
			});
			return { kind: 'ignored' };
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

	private duplicateWaitError(correlationValue: string, cause?: Error) {
		return new UserError(
			`A callback wait is already active for the identifier "${correlationValue}" on this tool`,
			{
				cause,
				description:
					'A callback resolves at most one wait, so two waits sharing an identifier would leave one of them suspended forever. Use an identifier that is unique among the tool calls currently in flight.',
			},
		);
	}
}
