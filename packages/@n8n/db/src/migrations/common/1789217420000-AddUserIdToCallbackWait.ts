import type { MigrationContext, ReversibleMigration } from '../migration-types';

const TABLE = 'callback_wait';

/**
 * The user a parked run was started as. A resume runs as that user, so the resumed segment
 * is pushed to the UI the same way the segment that parked was.
 */
export class AddUserIdToCallbackWait1789217420000 implements ReversibleMigration {
	async up({ schemaBuilder: { addColumns, column } }: MigrationContext) {
		await addColumns(TABLE, [column('userId').varchar(36)], { recreatesOnSqlite: true });
	}

	async down({ schemaBuilder: { dropColumns } }: MigrationContext) {
		await dropColumns(TABLE, ['userId'], { recreatesOnSqlite: true });
	}
}
