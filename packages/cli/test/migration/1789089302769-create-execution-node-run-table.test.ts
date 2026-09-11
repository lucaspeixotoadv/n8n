import {
	createTestMigrationContext,
	initDbUpToMigration,
	runSingleMigration,
	undoLastSingleMigration,
	type TestMigrationContext,
} from '@n8n/backend-test-utils';
import { DbConnection } from '@n8n/db';
import { Container } from '@n8n/di';
import { DataSource } from '@n8n/typeorm';
import { randomUUID } from 'node:crypto';

const MIGRATION_NAME = 'CreateExecutionNodeRunTable1789089302769';

describe('CreateExecutionNodeRunTable Migration', () => {
	let dataSource: DataSource;

	beforeAll(async () => {
		const dbConnection = Container.get(DbConnection);
		await dbConnection.init();
		dataSource = Container.get(DataSource);

		const context = createTestMigrationContext(dataSource);
		await context.queryRunner.clearDatabase();
		await context.queryRunner.release();

		await initDbUpToMigration(MIGRATION_NAME);
		// On Postgres this throws if `executionId` and `execution_entity.id` have
		// different key types, because the foreign key cannot be created.
		await runSingleMigration(MIGRATION_NAME);
	});

	afterAll(async () => {
		await Container.get(DbConnection).close();
	});

	async function tableExists(context: TestMigrationContext, name: string): Promise<boolean> {
		const table = `${context.tablePrefix}${name}`;
		if (context.isSqlite) {
			const rows = await context.runQuery<unknown[]>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = :table",
				{ table },
			);
			return rows.length === 1;
		}
		const rows = await context.runQuery<unknown[]>(
			'SELECT to_regclass(:table) AS oid WHERE to_regclass(:table) IS NOT NULL',
			{ table },
		);
		return rows.length === 1;
	}

	async function insertWorkflow(context: TestMigrationContext): Promise<string> {
		const workflowId = randomUUID();
		const now = new Date();
		await context.runQuery(
			`INSERT INTO ${context.escape.tableName('workflow_entity')} ("id", "name", "active", "nodes", "connections", "triggerCount", "versionId", "createdAt", "updatedAt")
			 VALUES (:id, :name, :active, :nodes, :connections, :triggerCount, :versionId, :createdAt, :updatedAt)`,
			{
				id: workflowId,
				name: `Journal test workflow ${workflowId}`,
				active: false,
				nodes: '[]',
				connections: '{}',
				triggerCount: 0,
				versionId: randomUUID(),
				createdAt: now,
				updatedAt: now,
			},
		);
		return workflowId;
	}

	async function insertExecution(context: TestMigrationContext): Promise<number> {
		const workflowId = await insertWorkflow(context);
		const table = context.escape.tableName('execution_entity');
		await context.runQuery(
			`INSERT INTO ${table} ("workflowId", "finished", "mode", "status", "createdAt")
			 VALUES (:workflowId, :finished, :mode, :status, :createdAt)`,
			{
				workflowId,
				finished: false,
				mode: 'manual',
				status: 'running',
				createdAt: new Date(),
			},
		);
		const [row] = await context.runQuery<Array<{ id: number }>>(
			`SELECT "id" FROM ${table} WHERE "workflowId" = :workflowId`,
			{ workflowId },
		);
		return row.id;
	}

	async function insertNodeRun(
		context: TestMigrationContext,
		executionId: number,
		seq: number,
	): Promise<void> {
		await context.runQuery(
			`INSERT INTO ${context.escape.tableName('execution_node_run')} ("executionId", "seq", "nodeName", "runIndex", "taskData", "createdAt")
			 VALUES (:executionId, :seq, :nodeName, :runIndex, :taskData, :createdAt)`,
			{
				executionId,
				seq,
				nodeName: 'Trigger',
				runIndex: 0,
				taskData: JSON.stringify({ startTime: 0, executionTime: 0 }),
				createdAt: new Date(),
			},
		);
	}

	describe('Up migration', () => {
		it('creates the execution_node_run table', async () => {
			const context = createTestMigrationContext(dataSource);
			try {
				const rows = await context.runQuery<unknown[]>(
					`SELECT * FROM ${context.escape.tableName('execution_node_run')}`,
				);
				expect(rows).toEqual([]);
			} finally {
				await context.queryRunner.release();
			}
		});

		it('keys the journal on the integer execution id', async () => {
			const context = createTestMigrationContext(dataSource);
			try {
				if (context.isSqlite) {
					const [row] = await context.runQuery<Array<{ sql: string }>>(
						"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = :table",
						{ table: `${context.tablePrefix}execution_node_run` },
					);
					expect(row.sql).toMatch(/"executionId"\s+integer/i);
				} else {
					const [row] = await context.runQuery<Array<{ type: string }>>(
						`SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
						 WHERE attrelid = :table::regclass AND attname = 'executionId'`,
						{ table: `${context.tablePrefix}execution_node_run` },
					);
					expect(row.type).toBe('integer');
				}
			} finally {
				await context.queryRunner.release();
			}
		});

		it('releases the journal with the execution it belongs to', async () => {
			const context = createTestMigrationContext(dataSource);
			try {
				const executionId = await insertExecution(context);
				await insertNodeRun(context, executionId, 1);

				const table = context.escape.tableName('execution_node_run');
				const before = await context.runQuery<unknown[]>(
					`SELECT * FROM ${table} WHERE "executionId" = :executionId`,
					{ executionId },
				);
				expect(before).toHaveLength(1);

				await context.runQuery(
					`DELETE FROM ${context.escape.tableName('execution_entity')} WHERE "id" = :executionId`,
					{ executionId },
				);

				const after = await context.runQuery<unknown[]>(
					`SELECT * FROM ${table} WHERE "executionId" = :executionId`,
					{ executionId },
				);
				expect(after).toHaveLength(0);
			} finally {
				await context.queryRunner.release();
			}
		});
	});

	describe('Down migration', () => {
		it('drops the execution_node_run table', async () => {
			await undoLastSingleMigration();

			const context = createTestMigrationContext(dataSource);
			try {
				expect(await tableExists(context, 'execution_node_run')).toBe(false);
			} finally {
				await context.queryRunner.release();
			}
		});
	});
});
