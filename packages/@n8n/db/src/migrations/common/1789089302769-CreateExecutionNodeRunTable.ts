import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'execution_node_run';

/**
 * Journal of node runs for executions that are still in flight.
 *
 * An execution's `data` is only written when the run ends, so until then nothing in the
 * database says how far it got. These rows are appended as each node finishes and dropped
 * once the consolidated snapshot lands, so the table only ever holds live executions.
 */
export class CreateExecutionNodeRunTable1789089302769 implements ReversibleMigration {
	async up({ schemaBuilder: { createTable, column }, tablePrefix }: MigrationContext) {
		await createTable(TABLE)
			.withColumns(
				column('executionId').varchar(36).primary.notNull,
				column('seq')
					.int.primary.notNull.comment(
						"Position in the execution's node-event order, monotonic across resumes",
					),
				column('nodeName').varchar(255).notNull,
				column('runIndex').int.notNull,
				column('taskData').json.notNull,
				column('createdAt').timestampTimezone().notNull,
			)
			.withForeignKey('executionId', {
				tableName: 'execution_entity',
				columnName: 'id',
				onDelete: 'CASCADE',
				name: `FK_${tablePrefix}execution_node_run_executionId`,
			});
	}

	async down({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable(TABLE);
	}
}
