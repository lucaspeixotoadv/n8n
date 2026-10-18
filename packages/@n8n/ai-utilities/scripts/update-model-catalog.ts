/**
 * Refreshes the model catalog snapshot from models.dev.
 *
 *   pnpm --filter @n8n/ai-utilities catalog:update            # fetch https://models.dev/api.json
 *   pnpm --filter @n8n/ai-utilities catalog:update --source ./api.json
 *   pnpm --filter @n8n/ai-utilities catalog:update --check    # exit 1 when the snapshot is stale
 *   pnpm --filter @n8n/ai-utilities catalog:update --force    # accept a large drop in models
 *
 * The runtime never calls this: pricing reads the committed snapshot only.
 */
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { parseModelCatalog } from '../src/model-catalog/catalog';
import { buildModelCatalogSnapshot, diffModelCatalogs } from '../src/model-catalog/snapshot';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const SNAPSHOT_PATH = join(__dirname, '..', 'src', 'model-catalog', 'snapshot.json');
/** More than this share of models disappearing is treated as a broken upstream document. */
const MAX_REMOVED_SHARE = 0.2;

function readFlag(name: string): string | boolean | undefined {
	const index = process.argv.indexOf(name);
	if (index === -1) return undefined;
	const value = process.argv[index + 1];
	return value === undefined || value.startsWith('--') ? true : value;
}

async function loadSource(source: string | boolean | undefined): Promise<unknown> {
	if (typeof source === 'string') {
		return JSON.parse(await readFile(source, 'utf-8'));
	}
	const response = await fetch(MODELS_DEV_URL);
	if (!response.ok) {
		throw new Error(`Fetching ${MODELS_DEV_URL} failed: ${response.status} ${response.statusText}`);
	}
	return await response.json();
}

async function loadCurrentSnapshot() {
	try {
		return parseModelCatalog(JSON.parse(await readFile(SNAPSHOT_PATH, 'utf-8')));
	} catch {
		return undefined;
	}
}

async function main() {
	const check = readFlag('--check') === true;
	const force = readFlag('--force') === true;
	const source = readFlag('--source');

	const document = await loadSource(source);
	const { catalog, skipped } = buildModelCatalogSnapshot(document, { generatedAt: new Date() });
	for (const entry of skipped) console.warn(`skipped ${entry}`);

	const current = await loadCurrentSnapshot();
	if (current) {
		const diff = diffModelCatalogs(current, catalog);
		console.log(
			[
				`providers: +${diff.addedProviders.length} -${diff.removedProviders.length}`,
				`models: ${diff.previousModelCount} -> ${diff.nextModelCount} (+${diff.addedModels.length} -${diff.removedModels.length}, ~${diff.changedModels.length} changed)`,
			].join('\n'),
		);
		for (const id of diff.removedProviders) console.log(`  - provider ${id}`);
		for (const id of diff.addedModels) console.log(`  + ${id}`);
		for (const id of diff.removedModels) console.log(`  - ${id}`);
		for (const id of diff.changedModels) console.log(`  ~ ${id}`);

		const unchanged =
			diff.addedModels.length + diff.removedModels.length + diff.changedModels.length === 0 &&
			diff.addedProviders.length + diff.removedProviders.length === 0;
		if (check) {
			if (!unchanged) {
				console.error('The model catalog snapshot is stale.');
				process.exit(1);
			}
			console.log('The model catalog snapshot is up to date.');
			return;
		}
		if (unchanged) {
			console.log('No changes; snapshot left untouched.');
			return;
		}

		const removedShare = diff.removedModels.length / Math.max(diff.previousModelCount, 1);
		if (removedShare > MAX_REMOVED_SHARE && !force) {
			console.error(
				`Refusing to drop ${(removedShare * 100).toFixed(0)}% of the models; pass --force if this is intended.`,
			);
			process.exit(1);
		}
	} else if (check) {
		console.error('No snapshot found.');
		process.exit(1);
	}

	await writeFile(SNAPSHOT_PATH, JSON.stringify(catalog, null, '\t') + '\n');
	console.log(`Wrote ${SNAPSHOT_PATH}`);
}

main().catch((error: unknown) => {
	console.error(error);
	process.exit(1);
});
