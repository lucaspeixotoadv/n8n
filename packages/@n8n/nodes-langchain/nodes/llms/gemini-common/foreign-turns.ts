import { AIMessage, type BaseMessage, type ToolCall } from '@langchain/core/messages';
import { isRecord } from '@n8n/utils/is-record';

/** The `model_provider` that `@langchain/google-genai` sets on its own messages. */
const GEMINI_MODEL_PROVIDER = 'google-genai';

function isForeignTurn(message: BaseMessage): message is AIMessage {
	if (!AIMessage.isInstance(message)) return false;
	const provider: unknown = message.response_metadata.model_provider;
	return typeof provider === 'string' && provider !== GEMINI_MODEL_PROVIDER;
}

/**
 * Keeps the text and the tool calls of a turn from another provider. The other
 * blocks, such as reasoning, are state of that provider: their signatures are not
 * valid for Gemini.
 */
function toGeminiTurn(message: AIMessage): AIMessage {
	const blocks = message.contentBlocks;

	const toolCalls: ToolCall[] = [];
	for (const block of blocks) {
		if (block.type === 'tool_call' && isRecord(block.args)) {
			toolCalls.push({ id: block.id, name: block.name, args: block.args, type: 'tool_call' });
		}
	}
	for (const toolCall of message.tool_calls ?? []) {
		if (!toolCalls.some(({ id }) => id === toolCall.id)) toolCalls.push(toolCall);
	}

	return new AIMessage({
		id: message.id,
		name: message.name,
		content: blocks.flatMap((block) =>
			block.type === 'text' ? [{ type: 'text' as const, text: block.text }] : [],
		),
		tool_calls: toolCalls,
		response_metadata: message.response_metadata,
	});
}

/**
 * Rewrites the AI turns of other providers into text and tool calls, which
 * `@langchain/google-genai` converts to Gemini parts.
 *
 * A model fallback puts the turns of another model into the history. They keep
 * the content blocks of that provider, for example Anthropic `thinking` and
 * `tool_use` blocks, and `@langchain/google-genai` converts only its own blocks.
 * The standard content blocks of the message (`contentBlocks`) give the turn in
 * a form that does not depend on the provider.
 */
export function toGeminiHistory(messages: BaseMessage[]): BaseMessage[] {
	return messages.map((message) => (isForeignTurn(message) ? toGeminiTurn(message) : message));
}
