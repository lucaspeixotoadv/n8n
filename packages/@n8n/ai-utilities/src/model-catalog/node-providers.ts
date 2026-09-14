/**
 * models.dev provider id for each LLM node type, so that a run of that node can be priced
 * without the node carrying any pricing knowledge. Nodes that talk to a local runtime
 * (Ollama, Lemonade) have no price and are absent on purpose.
 */
export const MODEL_CATALOG_PROVIDER_BY_NODE_TYPE: Readonly<Record<string, string>> = {
	'@n8n/n8n-nodes-langchain.lmChatOpenAi': 'openai',
	'@n8n/n8n-nodes-langchain.lmOpenAi': 'openai',
	'@n8n/n8n-nodes-langchain.lmChatAnthropic': 'anthropic',
	'@n8n/n8n-nodes-langchain.lmChatGoogleGemini': 'google',
	'@n8n/n8n-nodes-langchain.lmChatGoogleVertex': 'google-vertex',
	'@n8n/n8n-nodes-langchain.lmChatAzureOpenAi': 'azure',
	'@n8n/n8n-nodes-langchain.lmChatAwsBedrock': 'amazon-bedrock',
	'@n8n/n8n-nodes-langchain.lmChatOpenRouter': 'openrouter',
	'@n8n/n8n-nodes-langchain.lmChatGroq': 'groq',
	'@n8n/n8n-nodes-langchain.lmChatMistralCloud': 'mistral',
	'@n8n/n8n-nodes-langchain.lmChatDeepSeek': 'deepseek',
	'@n8n/n8n-nodes-langchain.lmChatXAiGrok': 'xai',
	'@n8n/n8n-nodes-langchain.lmChatCohere': 'cohere',
	'@n8n/n8n-nodes-langchain.lmCohere': 'cohere',
	'@n8n/n8n-nodes-langchain.lmChatVercelAiGateway': 'vercel',
	'@n8n/n8n-nodes-langchain.lmChatNvidia': 'nvidia',
	'@n8n/n8n-nodes-langchain.lmChatAlibabaCloud': 'alibaba',
	'@n8n/n8n-nodes-langchain.lmChatMinimax': 'minimax',
	'@n8n/n8n-nodes-langchain.lmChatMoonshot': 'moonshotai',
	'@n8n/n8n-nodes-langchain.lmOpenHuggingFaceInference': 'huggingface',
};

/** Providers kept in the shipped snapshot: every node provider above plus common gateways. */
export const MODEL_CATALOG_PROVIDERS: readonly string[] = [
	...new Set([
		...Object.values(MODEL_CATALOG_PROVIDER_BY_NODE_TYPE),
		'google-vertex-anthropic',
		'perplexity',
		'togetherai',
		'fireworks-ai',
		'cerebras',
		'zai',
		'ollama-cloud',
	]),
];
