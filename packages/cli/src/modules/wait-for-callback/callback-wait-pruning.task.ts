import { Logger } from '@n8n/backend-common';
import { Time } from '@n8n/constants';
import { intervalFromSeconds, SystemTask } from '@n8n/decorators';
import type { SystemTaskEffects, SystemTaskPlacement, SystemTaskSchedule } from '@n8n/decorators';

import { CallbackWaitConfig } from './callback-wait.config';
import { CallbackWaitRepository } from './callback-wait.repository';

/**
 * Applies retention to callback correlation rows.
 *
 * Two kinds of row accumulate. Resolved rows are kept only so a late duplicate is still
 * recognised as a duplicate rather than re-parked as a new early callback; once no sender
 * could plausibly still be retrying, they are of no use. Callbacks that arrived before
 * their wait are external-traffic writes and are dropped once nothing is going to claim
 * them. Rows of a live wait are never touched, however long that wait has been parked.
 */
@SystemTask()
export class CallbackWaitPruningTask implements SystemTask {
	readonly name = 'callback-wait-pruning';

	readonly schedule: SystemTaskSchedule = intervalFromSeconds(Time.hours.toSeconds);

	readonly effects: SystemTaskEffects = 'idempotent';

	readonly placement: SystemTaskPlacement = {
		scope: 'cluster',
		durable: true,
		runOnTakeover: true,
	};

	readonly retryDelaySeconds = 30;

	constructor(
		private readonly logger: Logger,
		private readonly repository: CallbackWaitRepository,
		private readonly config: CallbackWaitConfig,
	) {
		this.logger = this.logger.scoped('waiting-executions');
	}

	async run(): Promise<void> {
		const now = Date.now();
		const resolvedCutoff = new Date(
			now - this.config.resolvedRetentionHours * Time.hours.toMilliseconds,
		);
		const earlyCutoff = new Date(
			now - this.config.earlyCallbackRetentionHours * Time.hours.toMilliseconds,
		);

		const removed = await this.repository.pruneOlderThan({}, resolvedCutoff, earlyCutoff);
		if (removed > 0) this.logger.debug(`Pruned ${removed} callback correlation rows`);
	}
}
