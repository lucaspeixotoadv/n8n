import { BufferWindowMemory } from '@langchain/classic/memory';
import type { InputValues, MemoryVariables } from '@langchain/core/memory';
import type { BaseMessage } from '@langchain/core/messages';
import { getBufferString, isAIMessage } from '@langchain/core/messages';

function isToolResponse(message: BaseMessage): boolean {
	const type = message.getType();
	return type === 'tool' || type === 'function';
}

function isToolCallRequest(message: BaseMessage): boolean {
	return (
		isAIMessage(message) &&
		((message.tool_calls?.length ?? 0) > 0 || message.additional_kwargs?.function_call !== undefined)
	);
}

/**
 * Adjusts a context-window start index so the window never opens with a tool
 * response whose initiating tool call was cut off. Prefers extending the
 * window backwards to include the AI message that issued the call(s); if the
 * history has no such message (malformed), drops the orphaned responses by
 * moving the start forward to the next non-tool-response message.
 */
export function findSafeWindowStart(messages: BaseMessage[], start: number): number {
	if (start <= 0 || !isToolResponse(messages[start])) return start;

	// Parallel tool calls produce several consecutive tool responses after a
	// single AI message, so walk back over all of them.
	let back = start;
	while (back > 0 && isToolResponse(messages[back])) back--;
	if (isToolCallRequest(messages[back])) return back;

	let forward = start;
	while (forward < messages.length && isToolResponse(messages[forward])) forward++;
	return forward;
}

/**
 * Drop-in replacement for BufferWindowMemory with a turn-aware window
 * boundary. The upstream implementation slices the last `k * 2` messages by
 * count alone, which can split an AI tool-call message from its tool
 * response(s); providers such as Gemini reject a history that opens with an
 * unpaired tool response ("function response turn comes immediately after a
 * function call turn"). The boundary is adjusted so pairs are never split.
 */
export class TurnAwareBufferWindowMemory extends BufferWindowMemory {
	async loadMemoryVariables(_values: InputValues): Promise<MemoryVariables> {
		const messages = await this.chatHistory.getMessages();
		// k <= 0 mirrors upstream slice(-0), which returns the full history
		const requestedStart = this.k > 0 ? Math.max(0, messages.length - this.k * 2) : 0;
		const window = messages.slice(findSafeWindowStart(messages, requestedStart));

		if (this.returnMessages) {
			return { [this.memoryKey]: window };
		}
		return { [this.memoryKey]: getBufferString(window, this.humanPrefix, this.aiPrefix) };
	}
}
