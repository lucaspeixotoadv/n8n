import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'execution_node_run';

/**
 * Lets the journal record a node run starting, not only one finishing.
 *
 * A session that opens an execution mid-run learns from the journal what has finished, but
 * not which node the execution is on right now. A `started` row closes that gap; it has no
 * position among the node's runs yet, so `runIndex` becomes nullable. Existing rows are all
 * finished runs, which the default preserves.
 */
export class AddNodeStartsToExecutionNodeRun1789310000000 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, dropNotNull, column } }: MigrationContext) {
		await addColumns(TABLE, [column('kind').varchar(16).notNull.default("'finished'")], {
			recreatesOnSqlite: true,
		});
		await dropNotNull(TABLE, 'runIndex', { recreatesOnSqlite: true });
	}

	async down({ schemaBuilder: { addNotNull, dropColumns } }: MigrationContext) {
		await addNotNull(TABLE, 'runIndex', { recreatesOnSqlite: true });
		await dropColumns(TABLE, ['kind'], { recreatesOnSqlite: true });
	}
}
