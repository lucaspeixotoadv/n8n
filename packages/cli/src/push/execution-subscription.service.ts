import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { IExecutionResponse, User } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';
import { stringify } from 'flatted';

import { ExecutionPersistence } from '@/executions/execution-persistence';
import { ExecutionRedactionServiceProxy } from '@/executions/execution-redaction-proxy.service';
import { ExecutionSnapshotService } from '@/executions/execution-snapshot.service';
import { WorkflowSharingService } from '@/workflows/workflow-sharing.service';

import { ExecutionSubscriptionRegistry } from './execution-subscription.registry';
import { Push } from './index';
import type { OnPushMessage } from './types';

type SubscriptionMessage = {
	type: 'subscribeToExecution' | 'unsubscribeFromExecution';
	executionId: string;
};

function isSubscriptionMessage(msg: unknown): msg is SubscriptionMessage {
	if (typeof msg !== 'object' || msg === null) return false;

	const { type, executionId } = msg as Partial<SubscriptionMessage>;
	return (
		(type === 'subscribeToExecution' || type === 'unsubscribeFromExecution') &&
		typeof executionId === 'string' &&
		executionId.length > 0
	);
}

/**
 * Lets a frontend session watch an execution it has open.
 *
 * Until now a session received an execution's events only because it had started the run,
 * so entitlement never had to be asked: you saw what you launched. Watching is opt-in and
 * can name any execution, so entitlement is checked here, once, at subscribe time, against
 * the same workflow-level permission that governs reading the execution over HTTP.
 *
 * A subscription starts with a snapshot. The session that started a run receives its
 * baseline inside `executionStarted` and every event after it on the same channel; a
 * session that joins a run in progress must get the same guarantee, so the subscription is
 * registered first and the execution's state so far is then sent down the same channel.
 * Any event the execution produces after the registration follows the snapshot, and any
 * event it produced before is in the snapshot, so the session sees every step exactly
 * once whether it joined at the start, mid-run, or after a lost connection.
 *
 * The snapshot is redacted for the subscriber, as a read over HTTP would be.
 *
 * A permission that is revoked later does not retroactively close an open subscription; the
 * session stops receiving events when it disconnects or unsubscribes. That matches how the
 * editor already treats an execution it has open, and is called out so it is a decision
 * rather than an oversight.
 */
@Service()
export class ExecutionSubscriptionService {
	constructor(
		private readonly logger: Logger,
		private readonly push: Push,
		private readonly registry: ExecutionSubscriptionRegistry,
		private readonly executionPersistence: ExecutionPersistence,
		private readonly workflowSharingService: WorkflowSharingService,
		private readonly userRepository: UserRepository,
		private readonly executionSnapshotService: ExecutionSnapshotService,
		private readonly executionRedactionServiceProxy: ExecutionRedactionServiceProxy,
		private readonly globalConfig: GlobalConfig,
	) {
		this.logger = this.logger.scoped('push');
	}

	init() {
		this.push.on('message', (event: OnPushMessage) => {
			void this.handle(event).catch((error) => {
				this.logger.warn('Could not handle an execution subscription message', {
					pushRef: event.pushRef,
					error: ensureError(error).message,
				});
			});
		});
	}

	private async handle({ msg, pushRef, userId }: OnPushMessage): Promise<void> {
		if (!isSubscriptionMessage(msg)) return;

		if (msg.type === 'unsubscribeFromExecution') {
			this.registry.unsubscribe(msg.executionId, pushRef);
			return;
		}

		const user = await this.userRepository.findOne({ where: { id: userId }, relations: ['role'] });
		const execution = user ? await this.findWatchable(user, msg.executionId) : undefined;

		if (!user || !execution) {
			// Silent: answering would tell an unauthorized caller whether the execution exists.
			this.logger.debug('Refused an execution subscription', {
				pushRef,
				executionId: msg.executionId,
			});
			return;
		}

		// Registered before the snapshot is built, so an event that lands in between is
		// delivered after the snapshot rather than lost in front of it.
		this.registry.subscribe(msg.executionId, pushRef);

		await this.sendSnapshot(execution, user, pushRef);
	}

	/** The execution, if the user may read it by the rule that governs reading it at all. */
	private async findWatchable(
		user: User,
		executionId: string,
	): Promise<IExecutionResponse | undefined> {
		const accessibleWorkflowIds = await this.workflowSharingService.getSharedWorkflowIds(user, {
			scopes: ['workflow:read'],
		});
		if (accessibleWorkflowIds.length === 0) return undefined;

		const execution = await this.executionPersistence.findOneInWorkflows(
			executionId,
			accessibleWorkflowIds,
			{
				includeData: true,
				includeAnnotation: false,
				maxDataSizeBytes: this.globalConfig.executions.maxDisplaySize,
			},
		);

		return execution && 'data' in execution ? execution : undefined;
	}

	/**
	 * What the execution has done so far, as the subscriber may see it.
	 *
	 * Built the way a display read is: the stored snapshot completed with the journal, then
	 * redacted for the reader. Run data past the display limit is left out, as the read
	 * leaves it out, and the session keeps what it already holds.
	 */
	private async sendSnapshot(
		execution: IExecutionResponse,
		user: User,
		pushRef: string,
	): Promise<void> {
		const completed = await this.executionSnapshotService.complete(execution);

		let flattedRunData: string | undefined;
		const runData = completed.data?.resultData?.runData;
		if (runData !== undefined && !completed.dataTooLargeToDisplay) {
			const redacted = await this.executionRedactionServiceProxy.processExecution(completed, {
				user,
				keepOriginal: true,
			});
			flattedRunData = stringify(redacted.data.resultData.runData);
		}

		this.push.send(
			{
				type: 'executionSnapshot',
				data: {
					executionId: completed.id,
					workflowId: completed.workflowId,
					status: completed.status,
					...(flattedRunData !== undefined && { flattedRunData }),
				},
			},
			pushRef,
		);
	}
}
