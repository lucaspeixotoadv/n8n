import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'execution_node_run';

/**
 * The journal of node runs for in-flight executions is retired: nothing reads or writes
 * it any more. Its rows only described executions that were still running, so dropping
 * the table loses no record of a finished run.
 *
 * The `down` recreates the table at its final schema (the base columns plus the `kind`
 * column and the nullable `runIndex` added later), so a rollback restores a structurally
 * identical table. The rows are not recoverable.
 */
export class DropExecutionNodeRunTable1792351314480 implements ReversibleMigration {
	async up({ schemaBuilder: { dropTable } }: MigrationContext) {
		await dropTable(TABLE);
	}

	async down({ schemaBuilder: { createTable, column }, tablePrefix }: MigrationContext) {
		await createTable(TABLE)
			.withColumns(
				column('executionId').int.primary.notNull,
				column('seq').int.primary.notNull.comment(
					"Position in the execution's node-event order, monotonic across resumes",
				),
				column('nodeName').varchar(255).notNull,
				column('runIndex').int,
				column('taskData').json.notNull,
				column('createdAt').timestampTimezone().notNull,
				column('kind').varchar(16).notNull.default("'finished'"),
			)
			.withForeignKey('executionId', {
				tableName: 'execution_entity',
				columnName: 'id',
				onDelete: 'CASCADE',
				name: `FK_${tablePrefix}execution_node_run_executionId`,
			});
	}
}
