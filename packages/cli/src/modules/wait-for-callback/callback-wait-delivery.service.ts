import { Logger } from '@n8n/backend-common';
import { OnLifecycleEvent, OnPubSubEvent, type WorkflowExecuteAfterContext } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { WAIT_FOR_CALLBACK_TOOL_TYPE } from 'n8n-workflow';

import { CallbackWaitResumeService } from './callback-wait-resume.service';
import { CallbackWaitService } from './callback-wait.service';

import { Publisher } from '@/scaling/pubsub/publisher.service';

/**
 * Completes callback deliveries that arrived before their execution had parked.
 *
 * A tool call registers its wait from inside `execute()`, but the execution is only written
 * out as waiting once the engine unwinds. A callback landing in that window claims the
 * wait and then finds nothing resumable yet. Rather than poll for the execution to settle,
 * the delivery is finished from the lifecycle event that fires exactly when it does.
 *
 * The same event also cleans up after an execution that ended without resuming — cancelled,
 * failed, or finished — so its correlation keys are released instead of holding an
 * identifier hostage for a wait that can never be woken.
 */
@Service()
export class CallbackWaitDeliveryService {
	constructor(
		private readonly logger: Logger,
		private readonly callbackWaitService: CallbackWaitService,
		private readonly resumeService: CallbackWaitResumeService,
		private readonly instanceSettings: InstanceSettings,
		private readonly publisher: Publisher,
	) {
		this.logger = this.logger.scoped('waiting-executions');
	}

	@OnLifecycleEvent('workflowExecuteAfter')
	async handleWorkflowExecuteAfter(ctx: WorkflowExecuteAfterContext): Promise<void> {
		const executionId = ctx.executionId;
		if (!executionId) return;

		// This fires for every execution on the instance, so the workflow's own nodes decide
		// whether the correlation store is worth a query at all.
		if (!ctx.workflow.nodes.some((node) => node.type === WAIT_FOR_CALLBACK_TOOL_TYPE)) return;

		if (ctx.runData.status !== 'waiting') {
			// The execution is over. Any wait it still holds will never be resumed.
			await this.callbackWaitService.forgetExecution(executionId);
			return;
		}

		const undelivered = await this.callbackWaitService.findUndelivered(executionId);
		if (undelivered.length === 0) return;

		// In queue mode this runs on a worker, which must not drive a resume itself.
		if (this.instanceSettings.isWorker) {
			await this.publisher.publishCommand({
				command: 'deliver-pending-callbacks',
				payload: { executionId },
			});
			return;
		}

		await this.deliverPending(executionId);
	}

	@OnPubSubEvent('deliver-pending-callbacks', { instanceType: 'main' })
	async handleDeliveryRelay({ executionId }: { executionId: string }): Promise<void> {
		await this.deliverPending(executionId);
	}

	/**
	 * Delivers every claimed-but-undelivered callback of an execution.
	 *
	 * Only one can actually resume it — the execution leaves `waiting` on the first — and
	 * the rest simply find nothing to resume, which is the correct outcome for a wait whose
	 * execution has moved on.
	 */
	private async deliverPending(executionId: string): Promise<void> {
		const undelivered = await this.callbackWaitService.findUndelivered(executionId);

		for (const wait of undelivered) {
			try {
				const outcome = await this.resumeService.resume(wait, wait.payload ?? {});
				if (outcome === 'notParkedYet') continue;

				await this.callbackWaitService.markResolved(wait.id);
			} catch (error) {
				this.logger.error('Failed to deliver a callback that arrived before its wait parked', {
					executionId,
					waitId: wait.id,
					error: error instanceof Error ? error.message : String(error),
				});
				// Give the claim back, as the endpoint does, so a later delivery of the same
				// event can still wake the tool call. A row left in `resuming` would make every
				// such delivery a no-op and park the execution for good.
				await this.releaseClaim(wait.id);
			}
		}
	}

	private async releaseClaim(waitId: string): Promise<void> {
		try {
			await this.callbackWaitService.releaseClaim(waitId);
		} catch (error) {
			this.logger.error('Failed to release the claim of an undelivered callback', {
				waitId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}
