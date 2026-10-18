import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
	undoLastSingleMigration,
} from '@n8n/backend-test-utils';
import { DbConnection } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';

const MIGRATION_NAME = 'DropExecutionNodeRunTable1792351314480';

describe('DropExecutionNodeRunTable Migration', () => {
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

	async function hasNodeRunTable(): Promise<boolean> {
		dataSource = Container.get(DataSource);
		const context = createTestMigrationContext(dataSource);
		const exists = await context.queryRunner.hasTable(`${context.tablePrefix}execution_node_run`);
		await context.queryRunner.release();
		return exists;
	}

	it('drops the table the earlier migrations created', async () => {
		expect(await hasNodeRunTable()).toBe(true);

		await runSingleMigration(MIGRATION_NAME);

		expect(await hasNodeRunTable()).toBe(false);
	});

	it('recreates the table on rollback', async () => {
		await runSingleMigration(MIGRATION_NAME);
		await undoLastSingleMigration();

		expect(await hasNodeRunTable()).toBe(true);
	});
});
