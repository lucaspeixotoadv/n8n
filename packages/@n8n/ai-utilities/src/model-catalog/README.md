# Model catalog

Pricing and identity of LLM models, used to price each LLM invocation n8n runs.

- `snapshot.json` is a pruned copy of the [models.dev](https://models.dev) catalog
  (MIT). It ships with the package and is the only source the runtime reads: no
  network request is made when an invocation is priced, and a given n8n version
  prices the same way everywhere.
- `pricing.ts` finds the catalog entry for the id a node sent to its provider
  (`gpt-4o-2024-11-20` falls back to `gpt-4o`, `models/gemini-2.5-pro` to
  `gemini-2.5-pro`).
- `cost.ts` prices normalized token counts, with cache read/write and reasoning
  tokens as subsets of the prompt/completion counts, and context-size tiers.
  A model the catalog does not know, or a token category it has no rate for,
  leaves the cost unavailable instead of approximating it.
- `node-providers.ts` maps LLM node types to catalog providers, so nodes carry
  no pricing knowledge.

## Updating the snapshot

```sh
pnpm --filter @n8n/ai-utilities catalog:update            # fetch https://models.dev/api.json
pnpm --filter @n8n/ai-utilities catalog:update --source ./api.json
pnpm --filter @n8n/ai-utilities catalog:check             # exit 1 when the snapshot is stale
```

The script validates the upstream document, keeps the providers listed in
`MODEL_CATALOG_PROVIDERS`, prints what was added, removed and changed, and
refuses a run that would drop more than a fifth of the models unless `--force`
is given. Commit the resulting `snapshot.json`; `generatedAt` is the catalog
version persisted with every priced run.
