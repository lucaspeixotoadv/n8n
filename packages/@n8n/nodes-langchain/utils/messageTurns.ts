import type { BaseMessage } from '@langchain/core/messages';
import { isAIMessage } from '@langchain/core/messages';

/**
 * How a LangChain message maps onto a conversation turn of a tool-using
 * exchange. Shared so that every layer reasoning about turn boundaries — the
 * memory context window, the provider adapters that must satisfy a provider's
 * turn ordering — classifies messages the same way.
 */

/** An AI message requesting tool call(s): a `functionCall` turn for Gemini. */
export function isToolCallRequest(message: BaseMessage): boolean {
	return (
		isAIMessage(message) &&
		((message.tool_calls?.length ?? 0) > 0 ||
			message.additional_kwargs?.function_call !== undefined)
	);
}

/** A response to a tool call: a `functionResponse` turn for Gemini. */
export function isToolResponse(message: BaseMessage): boolean {
	const type = message.getType();
	return type === 'tool' || type === 'function';
}

/**
 * A tool-use cycle is the AI message requesting tool call(s) plus the responses
 * to it. Neither half can open a conversation: both only make sense as a
 * continuation of the user turn that triggered them.
 */
export function isPartOfToolCycle(message: BaseMessage): boolean {
	return isToolCallRequest(message) || isToolResponse(message);
}
