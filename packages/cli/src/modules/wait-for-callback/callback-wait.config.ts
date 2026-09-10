import { Config, Env } from '@n8n/config';

@Config
export class CallbackWaitConfig {
	/**
	 * How many callbacks that arrived before their wait a single endpoint may hold.
	 * @default 100
	 */
	@Env('N8N_CALLBACK_WAIT_MAX_EARLY_CALLBACKS')
	maxEarlyCallbacksPerNamespace: number = 100;

	/**
	 * Largest callback body kept while waiting for its tool call to register, in bytes.
	 * @default 65536
	 */
	@Env('N8N_CALLBACK_WAIT_MAX_BODY_BYTES')
	maxCallbackBodyBytes: number = 65536;

	/**
	 * How many hours a resolved correlation row is kept so late duplicates stay
	 * recognisable as duplicates.
	 * @default 72
	 */
	@Env('N8N_CALLBACK_WAIT_RESOLVED_RETENTION_HOURS')
	resolvedRetentionHours: number = 72;

	/**
	 * How many hours a callback that arrived before its wait is kept before it is dropped.
	 * @default 168
	 */
	@Env('N8N_CALLBACK_WAIT_EARLY_RETENTION_HOURS')
	earlyCallbackRetentionHours: number = 168;
}
