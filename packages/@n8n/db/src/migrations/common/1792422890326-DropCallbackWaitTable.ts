import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'callback_wait';

/**
 * The Wait for Callback AI tool is retired: nothing reads or writes its correlation rows
 * any more. A tool that waits for an external callback now uses the Wait node, which
 * resumes the execution through its own resume URL.
 *
 * The `down` recreates the table at its final schema (the base columns, their indexes and
 * the `userId` column added later), so a rollback restores a structurally identical table.
 * The rows are not recoverable.
 */
export class DropCallbackWaitTable1792422890326 implements ReversibleMigration {
	async up({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable(TABLE);
	}

	async down({
		schemaBuilder: { createTable, createIndex, column },
		tablePrefix,
	}: MigrationContext) {
		await createTable(TABLE).withColumns(
			column('id').varchar(36).primary.notNull,
			column('namespace')
				.varchar(36)
				.notNull.comment('Webhook registration that owns the endpoint receiving the callback'),
			column('correlationValue')
				.varchar(255)
				.notNull.comment('External correlation id, normalised to its string form'),
			column('activeKey')
				.varchar(292)
				.comment('namespace:correlationValue while live, NULL once resolved'),
			column('status').varchar(32).notNull,
			column('executionId').varchar(36).comment('NULL while the row is only a parked callback'),
			column('toolCallId').varchar(255),
			column('nodeId').varchar(36),
			column('workflowId').varchar(36),
			column('payload').json.comment('Callback body only; headers and query are never stored here'),
			column('payloadReceivedAt').timestampTimezone(),
			column('resolvedAt').timestampTimezone(),
			column('userId').varchar(36),
		).withTimestamps;

		await createIndex(
			TABLE,
			['activeKey'],
			true,
			`${tablePrefix}uq_callback_wait_active_key`,
			'"activeKey" IS NOT NULL',
		);
		await createIndex(TABLE, ['namespace', 'correlationValue']);
		await createIndex(TABLE, ['executionId']);
	}
}
