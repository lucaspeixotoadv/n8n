import { Config, Env } from '@n8n/config';

@Config
export class ExecutionJournalConfig {
	/**
	 * Whether to record each node run as it finishes, so an execution's progress is
	 * readable before it ends. Rows are dropped once the execution's snapshot covers them.
	 *
	 * Off by default: it costs one write per node run, which is what an instance that sets
	 * `EXECUTIONS_DATA_SAVE_ON_PROGRESS=false` is avoiding. Turn it on to read an execution
	 * while it runs, and to keep what a crashed one reached.
	 * @default false
	 */
	@Env('N8N_EXECUTIONS_JOURNAL_ENABLED')
	enabled: boolean = false;

	/**
	 * Largest task recorded in full. A larger one is journalled as a placeholder; the
	 * execution's own snapshot still carries it.
	 * @default 1048576
	 */
	@Env('N8N_EXECUTIONS_JOURNAL_MAX_TASK_BYTES')
	maxTaskBytes: number = 1024 * 1024;
}
