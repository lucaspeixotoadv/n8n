import { UserError } from 'n8n-workflow';

/** The execution that owns the correlation key a registration collided with. */
export type CallbackWaitHolder = {
	executionId: string;
	/**
	 * When the key was taken: the moment the holder registered its wait, or, for a callback
	 * that arrived first and the holder consumed, the moment that callback landed.
	 */
	since: Date;
};

/**
 * A tool call asked to wait for a callback identifier another execution already holds.
 *
 * A callback resolves exactly one wait, and the key is taken by the registration the
 * database committed first (the partial unique index on `activeKey`). Every later
 * registration for the same key fails here, before it can park anything: the losing
 * execution never enters `waiting`, so no callback can be split between two runs and no
 * run is left suspended for a callback that will wake somebody else.
 *
 * The message names the holder when it is known. It is what the agent gets as the tool
 * result, and what an operator reads on the failed tool call, so it has to say which
 * execution the callback belongs to and since when.
 */
export class CallbackWaitCollisionError extends UserError {
	constructor(
		readonly correlationValue: string,
		readonly holder: CallbackWaitHolder | null,
		cause?: Error,
	) {
		const holderClause = holder
			? `: execution ${holder.executionId} has held this identifier since ${holder.since.toISOString()}`
			: '';

		super(
			`Another execution is already waiting for the callback "${correlationValue}" on this tool${holderClause}. The callback will resume that execution only, so this tool call cannot wait for it.`,
			{
				cause,
				description:
					'A callback resolves at most one wait. Use an identifier that is unique among the tool calls currently in flight, or let the execution holding this one finish first.',
				extra: {
					correlationValue,
					holderExecutionId: holder?.executionId,
					holderSince: holder?.since.toISOString(),
				},
			},
		);
	}
}
