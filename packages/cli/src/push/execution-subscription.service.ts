import { Logger } from '@n8n/backend-common';
import type { User } from '@n8n/db';
import { UserRepository } from '@n8n/db';
import { Service } from '@n8n/di';
import { ensureError } from '@n8n/utils/errors/ensure-error';

import { ExecutionPersistence } from '@/executions/execution-persistence';
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

		if (!(await this.mayWatch(userId, msg.executionId))) {
			// Silent: answering would tell an unauthorized caller whether the execution exists.
			this.logger.debug('Refused an execution subscription', {
				pushRef,
				executionId: msg.executionId,
			});
			return;
		}

		this.registry.subscribe(msg.executionId, pushRef);
	}

	/** Whether the user may read this execution, by the rule that governs reading it at all. */
	private async mayWatch(userId: User['id'], executionId: string): Promise<boolean> {
		const user = await this.userRepository.findOne({ where: { id: userId }, relations: ['role'] });
		if (!user) return false;

		const accessibleWorkflowIds = await this.workflowSharingService.getSharedWorkflowIds(user, {
			scopes: ['workflow:read'],
		});
		if (accessibleWorkflowIds.length === 0) return false;

		const execution = await this.executionPersistence.findOneInWorkflows(
			executionId,
			accessibleWorkflowIds,
			{ includeData: false, includeAnnotation: false },
		);

		return execution !== undefined;
	}
}
