import { Logger } from '@n8n/backend-common';
import { Time } from '@n8n/constants';
import { OnLeaderStepdown, OnLeaderTakeover, OnShutdown } from '@n8n/decorators';
import { Service } from '@n8n/di';
import { InstanceSettings } from 'n8n-core';
import { ensureError } from '@n8n/utils/errors/ensure-error';

import { CallbackWaitConfig } from './callback-wait.config';
import { CallbackWaitRepository } from './callback-wait.repository';

const SWEEP_INTERVAL_MS = 60 * Time.minutes.toMilliseconds;

/**
 * Applies retention to callback correlation rows.
 *
 * Two kinds of row accumulate. Resolved rows are kept only so a late duplicate is still
 * recognised as a duplicate rather than re-parked as a new early callback; once no sender
 * could plausibly still be retrying, they are of no use. Callbacks that arrived before
 * their wait are external-traffic writes and are dropped once nothing is going to claim
 * them. Rows of a live wait are never touched, however long that wait has been parked.
 */
@Service()
export class CallbackWaitPruningService {
	private timer?: NodeJS.Timeout;

	constructor(
		private readonly logger: Logger,
		private readonly repository: CallbackWaitRepository,
		private readonly config: CallbackWaitConfig,
		private readonly instanceSettings: InstanceSettings,
	) {
		this.logger = this.logger.scoped('waiting-executions');
	}

	init() {
		if (this.instanceSettings.isLeader) this.startSweeping();
	}

	@OnLeaderTakeover()
	private startSweeping() {
		this.timer ??= setInterval(() => {
			void this.sweep();
		}, SWEEP_INTERVAL_MS);
		void this.sweep();
	}

	@OnLeaderStepdown()
	@OnShutdown()
	stopSweeping() {
		if (!this.timer) return;

		clearInterval(this.timer);
		this.timer = undefined;
	}

	async sweep(): Promise<void> {
		const now = Date.now();
		const resolvedCutoff = new Date(
			now - this.config.resolvedRetentionHours * Time.hours.toMilliseconds,
		);
		const earlyCutoff = new Date(
			now - this.config.earlyCallbackRetentionHours * Time.hours.toMilliseconds,
		);

		try {
			const removed = await this.repository.pruneOlderThan({}, resolvedCutoff, earlyCutoff);
			if (removed > 0) this.logger.debug(`Pruned ${removed} callback correlation rows`);
		} catch (error) {
			this.logger.warn('Failed to prune callback correlation rows', {
				error: ensureError(error).message,
			});
		}
	}
}
