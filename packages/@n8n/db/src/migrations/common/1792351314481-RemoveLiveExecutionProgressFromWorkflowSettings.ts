import type { IrreversibleMigration, MigrationContext } from '../migration-types';

const SETTING = 'liveExecutionProgress';

type WorkflowRow = { id: string; settings: string | Record<string, unknown> | null };

/**
 * Removes the retired `liveExecutionProgress` workflow setting.
 *
 * The setting chose whether an execution kept the node-run journal, which no longer
 * exists. The Public API validates workflow settings strictly, so a workflow that still
 * carried the key could not be written back as it was read. Removing it keeps every
 * other setting as it is.
 *
 * Irreversible: the value is meaningless once the journal is gone, so there is nothing
 * to restore.
 *
 * Compatible with SQLite and PostgreSQL.
 */
export class RemoveLiveExecutionProgressFromWorkflowSettings1792351314481
	implements IrreversibleMigration
{
	async up({ escape, runQuery, runInBatches, parseJson }: MigrationContext) {
		const workflowTable = escape.tableName('workflow_entity');
		const id = escape.columnName('id');
		const settings = escape.columnName('settings');

		// Every workflow is read in a stable order: `runInBatches` pages with LIMIT/OFFSET, so a
		// filter on the key would shrink under the updates and skip rows.
		await runInBatches<WorkflowRow>(
			`SELECT ${id}, ${settings} FROM ${workflowTable} ORDER BY ${id}`,
			async (rows) => {
				for (const row of rows) {
					if (row.settings === null) continue;

					const parsed = parseJson<Record<string, unknown>>(row.settings);
					if (!(SETTING in parsed)) continue;

					const { [SETTING]: _retired, ...rest } = parsed;
					await runQuery(`UPDATE ${workflowTable} SET ${settings} = :settings WHERE ${id} = :id`, {
						settings: JSON.stringify(rest),
						id: row.id,
					});
				}
			},
		);
	}
}
