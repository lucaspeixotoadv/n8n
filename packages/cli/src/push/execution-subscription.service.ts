import { Logger } from '@n8n/backend-common';
import { GlobalConfig } from '@n8n/config';
import type { IExecutionResponse, User } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { OnPubSubEvent } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { stringify } from 'flatted';
import { InstanceSettings } from 'n8n-core';

import { NotFoundError } from '@/errors/response-errors/not-found.error';
import { nodeEventSequence } from '@/execution-lifecycle/node-event-sequence';
import { ExecutionPersistence } from '@/executions/execution-persistence';
import { ExecutionRedactionServiceProxy } from '@/executions/execution-redaction-proxy.service';
import { ExecutionSnapshotService } from '@/executions/execution-snapshot.service';
import { Publisher } from '@/scaling/pubsub/publisher.service';
import type { PubSubCommandMap } from '@/scaling/pubsub/pubsub.event-map';
import { WorkflowSharingService } from '@/workflows/workflow-sharing.service';

import { ExecutionSubscriptionRegistry } from './execution-subscription.registry';
import { Push } from './index';

/**
 * Lets a frontend session watch an execution it has open.
 *
 * A session received an execution's events only because it had started the run, so
 * entitlement never had to be asked: you saw what you launched. Watching is opt-in and can
 * name any execution, so entitlement is checked here, once, at subscribe time, against the
 * same workflow-level permission that governs reading the execution over HTTP.
 *
 * The request arrives over HTTP, like every other thing a session asks the server for, and
 * names the session by its push ref. The push channel itself stays one-directional, which
 * is what lets it be a plain event stream where the deployment asks for one.
 *
 * A subscription starts with a snapshot. The session that started a run receives its
 * baseline inside `executionStarted` and every event after it on the same channel; a
 * session that joins a run in progress must get the same guarantee, so the subscription is
 * registered first and the execution's state so far is then sent down the same channel.
 * Any event the execution produces after the registration follows the snapshot, and any
 * event it produced before is in the snapshot, so the session sees every step exactly
 * once whether it joined at the start, mid-run, or after a lost connection.
 *
 * The registry is local to the instance that holds the session's connection, because that
 * is the instance that delivers. In a multi-main deployment the request may land elsewhere,
 * and is then relayed to the instance that holds the session.
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
		private readonly instanceSettings: InstanceSettings,
		private readonly publisher: Publisher,
	) {
		this.logger = this.logger.scoped('push');
	}

	/**
	 * Starts sending the execution's events to the session, beginning with a snapshot.
	 *
	 * Refused as not found when the user may not read the execution, which is also what a
	 * read over HTTP answers, so the refusal reveals nothing a read would not.
	 */
	async subscribe(user: User, executionId: string, pushRef: string): Promise<void> {
		const execution = await this.findWatchable(user, executionId);
		if (!execution) throw new NotFoundError('Execution not found');

		if (this.push.hasPushRef(pushRef)) {
			await this.register(execution, user, pushRef);
			return;
		}

		if (this.instanceSettings.isMultiMain) {
			await this.publisher.publishCommand({
				command: 'relay-execution-subscription',
				payload: { action: 'subscribe', executionId, pushRef, userId: user.id },
			});
			return;
		}

		// The session is not connected: it subscribes again when it is.
		this.logger.debug('Ignored an execution subscription from a session that is not connected', {
			pushRef,
			executionId,
		});
	}

	/** Stops sending the execution's events to the session. Needs no entitlement. */
	async unsubscribe(executionId: string, pushRef: string): Promise<void> {
		if (this.push.hasPushRef(pushRef)) {
			this.registry.unsubscribe(executionId, pushRef);
			return;
		}

		if (this.instanceSettings.isMultiMain) {
			await this.publisher.publishCommand({
				command: 'relay-execution-subscription',
				payload: { action: 'unsubscribe', executionId, pushRef },
			});
		}
	}

	/** A subscription request another main took for a session this instance may hold. */
	@OnPubSubEvent('relay-execution-subscription', { instanceType: 'main' })
	async handleRelayedSubscription({
		action,
		executionId,
		pushRef,
		userId,
	}: PubSubCommandMap['relay-execution-subscription']): Promise<void> {
		if (!this.push.hasPushRef(pushRef)) return;

		if (action === 'unsubscribe') {
			this.registry.unsubscribe(executionId, pushRef);
			return;
		}

		const user = userId
			? await this.userRepository.findOne({ where: { id: userId }, relations: ['role'] })
			: null;
		const execution = user ? await this.findWatchable(user, executionId) : undefined;
		if (!user || !execution) return;

		await this.register(execution, user, pushRef);
	}

	/**
	 * Registered before the snapshot is built, so an event that lands in between is
	 * delivered after the snapshot rather than lost in front of it.
	 */
	private async register(execution: IExecutionResponse, user: User, pushRef: string) {
		this.registry.subscribe(execution.id, pushRef);

		try {
			await this.sendSnapshot(execution, user, pushRef);
		} catch (error) {
			// The subscription stands: the events that follow still reach the session, and the
			// stored execution completes the picture when the run ends.
			this.logger.warn('Could not send an execution snapshot to a subscriber', {
				pushRef,
				executionId: execution.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
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
	 * What the execution has done so far, and what it is doing now, as the subscriber may
	 * see it.
	 *
	 * Built the way a display read is: the stored snapshot completed with the journal, then
	 * redacted for the reader. Run data past the display limit is left out, as the read
	 * leaves it out, and the session keeps what it already holds. The node the execution is
	 * on right now has produced nothing to redact and is always sent.
	 */
	private async sendSnapshot(
		execution: IExecutionResponse,
		user: User,
		pushRef: string,
	): Promise<void> {
		const { execution: completed, executingNodes } =
			await this.executionSnapshotService.progress(execution);

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
					...(executingNodes.length > 0 && {
						executingNodes: executingNodes.map(({ nodeName, data }) => ({
							nodeName,
							sequenceNumber: nodeEventSequence(data.executionIndex, 'started'),
							data,
						})),
					}),
				},
			},
			pushRef,
		);
	}
}
