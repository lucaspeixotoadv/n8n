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

	it('runs on a database that has no callback_wait table', async () => {
		expect(await callbackWaitTable()).toBeUndefined();

		await runSingleMigration(MIGRATION_NAME);

		expect(await callbackWaitTable()).toBeUndefined();
	});

	it('recreates the table at its final schema on rollback', async () => {
		await runSingleMigration(MIGRATION_NAME);
		await undoLastSingleMigration();

		const table = await callbackWaitTable();
		expect(table?.columns.map((column) => column.name).sort()).toEqual(
			[
				'activeKey',
				'correlationValue',
				'createdAt',
				'executionId',
				'id',
				'namespace',
				'nodeId',
				'payload',
				'payloadReceivedAt',
				'resolvedAt',
				'status',
				'toolCallId',
				'updatedAt',
				'userId',
				'workflowId',
			].sort(),
		);
		expect(table?.indices.map((index) => index.columnNames.join(',')).sort()).toEqual(
			['activeKey', 'executionId', 'namespace,correlationValue'].sort(),
		);
	});

	it('drops the table when it exists', async () => {
		await runSingleMigration(MIGRATION_NAME);
		await undoLastSingleMigration();
		expect(await callbackWaitTable()).toBeDefined();

		await runSingleMigration(MIGRATION_NAME);

		expect(await callbackWaitTable()).toBeUndefined();
	});
});
