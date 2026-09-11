import { Config, Env } from '@n8n/config';

@Config
export class ExecutionJournalConfig {
	/**
	 * Whether to record each node run as it finishes, so an execution's progress is
	 * readable before it ends. Rows are dropped once the execution's snapshot covers them.
	 * @default true
	 */
	@Env('N8N_EXECUTIONS_JOURNAL_ENABLED')
	enabled: boolean = true;

	/**
	 * Largest task recorded in full. A larger one is journalled as a placeholder; the
	 * execution's own snapshot still carries it.
	 * @default 1048576
	 */
	@Env('N8N_EXECUTIONS_JOURNAL_MAX_TASK_BYTES')
	maxTaskBytes: number = 1024 * 1024;
}
