import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
	undoLastSingleMigration,
} from '@n8n/backend-test-utils';
import { DbConnection } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

const MIGRATION_NAME = 'DropCallbackWaitTable1792422890326';

describe('DropCallbackWaitTable Migration', () => {
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

	async function callbackWaitTable() {
		dataSource = Container.get(DataSource);
		const context = createTestMigrationContext(dataSource);
		const table = await context.queryRunner.getTable(`${context.tablePrefix}callback_wait`);
		await context.queryRunner.release();
		return table;
	}

	it('drops the table the earlier migrations created', async () => {
		expect(await callbackWaitTable()).toBeDefined();

		await runSingleMigration(MIGRATION_NAME);

		expect(await callbackWaitTable()).toBeUndefined();
	});

	it('recreates the table at its final schema on rollback', async () => {
		const before = await callbackWaitTable();

		await runSingleMigration(MIGRATION_NAME);
		await undoLastSingleMigration();

		const after = await callbackWaitTable();
		expect(after?.columns.map((column) => column.name).sort()).toEqual(
			before?.columns.map((column) => column.name).sort(),
		);
		expect(after?.indices.map((index) => index.columnNames.join(',')).sort()).toEqual(
			before?.indices.map((index) => index.columnNames.join(',')).sort(),
		);
	});
});
