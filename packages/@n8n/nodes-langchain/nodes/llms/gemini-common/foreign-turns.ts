import {
	AIMessage,
	type AIMessageFields,
	type BaseMessage,
	type MessageContentText,
	type ToolCall,
} from '@langchain/core/messages';
import { isRecord } from '@n8n/utils/is-record';

function isForeignTurn(message: BaseMessage, ownProvider: string): message is AIMessage {
	if (!AIMessage.isInstance(message)) return false;
	const provider: unknown = message.response_metadata.model_provider;
	return typeof provider === 'string' && provider !== ownProvider;
}

/**
 * Returns the fields of a turn from another provider that Gemini can replay: the
 * text and the tool calls. The other blocks, such as reasoning, are state of that
 * provider: their signatures are not valid for Gemini.
 *
 * The standard content blocks of the message (`contentBlocks`) give the turn in a
 * form that does not depend on the provider.
 */
export function toTextAndToolCalls(message: AIMessage) {
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

	const content: MessageContentText[] = blocks.flatMap((block) =>
		block.type === 'text' && block.text.length > 0 ? [{ type: 'text', text: block.text }] : [],
	);

	return {
		id: message.id,
		name: message.name,
		content,
		tool_calls: toolCalls,
		response_metadata: message.response_metadata,
	} satisfies AIMessageFields;
}

/**
 * Rewrites the AI turns of other providers in a history for a Gemini model.
 *
 * A model fallback puts the turns of another model into the history. They keep
 * the content blocks of that provider, for example Anthropic `thinking` and
 * `tool_use` blocks, and the Gemini integrations convert only their own blocks.
 *
 * @param ownProvider - The `model_provider` that the Gemini integration sets on its own messages
 * @param rewrite - Makes a Gemini turn from a turn of another provider
 */
export function rewriteForeignTurns(
	messages: BaseMessage[],
	ownProvider: string,
	rewrite: (turn: AIMessage) => AIMessage,
): BaseMessage[] {
	return messages.map((message) =>
		isForeignTurn(message, ownProvider) ? rewrite(message) : message,
	);
}
