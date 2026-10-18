import { readFile } from 'fs/promises';
import { jsonParse } from 'n8n-workflow';
import { join } from 'path';

import { modelCatalogSchema } from './schema';
import type { ModelCatalog } from './types';

let catalogPromise: Promise<ModelCatalog> | undefined;

/** Parses and validates a catalog snapshot document. Throws when the document is malformed. */
export function parseModelCatalog(document: unknown): ModelCatalog {
	return modelCatalogSchema.parse(document);
}

/**
 * Loads the snapshot shipped with the package. Read once, from disk, never from the
 * network: pricing an invocation must not depend on connectivity or on upstream changes.
 */
export async function loadModelCatalog(): Promise<ModelCatalog> {
	catalogPromise ??= (async () => {
		const content = await readFile(join(__dirname, 'snapshot.json'), 'utf-8');
		return parseModelCatalog(jsonParse(content));
	})().catch((error: unknown) => {
		catalogPromise = undefined;
		throw error;
	});
	return await catalogPromise;
}
