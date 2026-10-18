import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'callback_wait';

/**
 * Correlation rows for AI tool calls that park until an external HTTP callback arrives.
 *
 * The partial unique index on `activeKey` is the invariant that keeps a callback able to
 * resolve exactly one wait: while a row is live it holds `namespace:correlationValue`
 * there, and a second live row for the same key is rejected by the database. Resolved rows
 * release the key by setting it to NULL, so the history of a key can accumulate without
 * blocking the next wait.
 */
export class CreateCallbackWaitTable1789079836998 implements ReversibleMigration {
	async up({ schemaBuilder: { createTable, createIndex, column }, tablePrefix }: MigrationContext) {
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

	async down({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable(TABLE);
	}
}
