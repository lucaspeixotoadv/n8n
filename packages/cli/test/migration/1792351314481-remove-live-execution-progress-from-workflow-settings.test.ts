import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
	type TestMigrationContext,
} from '@n8n/backend-test-utils';
import { DbConnection } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import { nanoid } from 'nanoid';
import { jsonParse } from 'n8n-workflow';

const MIGRATION_NAME = 'RemoveLiveExecutionProgressFromWorkflowSettings1792351314481';

describe('RemoveLiveExecutionProgressFromWorkflowSettings Migration', () => {
	let dataSource: DataSource;

	beforeEach(async () => {
		const dbConnection = Container.get(DbConnection);
		await dbConnection.init();

		dataSource = Container.get(DataSource);
		const context = createTestMigrationContext(dataSource);
		await context.queryRunner.clearDatabase();
		await context.queryRunner.release();
		await initDbUpToMigration(MIGRATION_NAME);
	});

	afterEach(async () => {
		const dbConnection = Container.get(DbConnection);
		await dbConnection.close();
	});

	async function insertWorkflow(
		context: TestMigrationContext,
		id: string,
		settings: Record<string, unknown> | null,
	): Promise<void> {
		const table = context.escape.tableName('workflow_entity');
		const columns = [
			'id',
			'name',
			'active',
			'nodes',
			'connections',
			'settings',
			'createdAt',
			'updatedAt',
			'triggerCount',
			'versionId',
		].map((name) => context.escape.columnName(name));

		await context.runQuery(
			`INSERT INTO ${table} (${columns.join(', ')}) VALUES (:id, :name, :active, :nodes, :connections, :settings, :createdAt, :updatedAt, :triggerCount, :versionId)`,
			{
				id,
				name: `Workflow ${id}`,
				active: false,
				nodes: '[]',
				connections: '{}',
				settings: settings === null ? null : JSON.stringify(settings),
				createdAt: new Date(),
				updatedAt: new Date(),
				triggerCount: 0,
				versionId: nanoid(),
			},
		);
	}

	async function settingsOf(id: string): Promise<Record<string, unknown> | null> {
		dataSource = Container.get(DataSource);
		const context = createTestMigrationContext(dataSource);
		const table = context.escape.tableName('workflow_entity');
		const rows = await context.runQuery<
			Array<{ settings: string | Record<string, unknown> | null }>
		>(
			`SELECT ${context.escape.columnName('settings')} AS "settings" FROM ${table} WHERE ${context.escape.columnName('id')} = :id`,
			{ id },
		);
		await context.queryRunner.release();

		// Postgres returns the json column already parsed; SQLite returns text.
		const { settings } = rows[0];
		if (settings === null) return null;
		return typeof settings === 'string' ? jsonParse<Record<string, unknown>>(settings) : settings;
	}

	it('removes the retired setting and keeps every other setting', async () => {
		const context = createTestMigrationContext(dataSource);
		await insertWorkflow(context, 'wf-on', {
			liveExecutionProgress: true,
			saveExecutionProgress: true,
			timezone: 'America/Sao_Paulo',
		});
		await insertWorkflow(context, 'wf-off', { liveExecutionProgress: false });
		await context.queryRunner.release();

		await runSingleMigration(MIGRATION_NAME);

		expect(await settingsOf('wf-on')).toEqual({
			saveExecutionProgress: true,
			timezone: 'America/Sao_Paulo',
		});
		expect(await settingsOf('wf-off')).toEqual({});
	});

	it('leaves workflows without the setting untouched', async () => {
		const context = createTestMigrationContext(dataSource);
		await insertWorkflow(context, 'wf-plain', { executionOrder: 'v1' });
		await insertWorkflow(context, 'wf-null', null);
		await context.queryRunner.release();

		await runSingleMigration(MIGRATION_NAME);

		expect(await settingsOf('wf-plain')).toEqual({ executionOrder: 'v1' });
		expect(await settingsOf('wf-null')).toBeNull();
	});

	it('reaches every workflow when they span several batches', async () => {
		const context = createTestMigrationContext(dataSource);
		const ids = Array.from({ length: 250 }, (_, index) => `wf-${String(index).padStart(3, '0')}`);
		for (const id of ids) {
			await insertWorkflow(context, id, { liveExecutionProgress: true });
		}
		await context.queryRunner.release();

		await runSingleMigration(MIGRATION_NAME);

		for (const id of [ids[0], ids[99], ids[100], ids[249]]) {
			expect(await settingsOf(id)).toEqual({});
		}
	});
});
