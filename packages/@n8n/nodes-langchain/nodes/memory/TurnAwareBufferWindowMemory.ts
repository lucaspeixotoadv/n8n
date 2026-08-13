import { BufferWindowMemory } from '@langchain/classic/memory';
import type { InputValues, MemoryVariables } from '@langchain/core/memory';
import type { BaseMessage } from '@langchain/core/messages';
import { getBufferString } from '@langchain/core/messages';

import { isPartOfToolCycle, isToolCallRequest } from '@utils/messageTurns';

function isUserTurn(message: BaseMessage): boolean {
	return message.getType() === 'human';
}

/**
 * Adjusts a context-window start index so the window opens on a conversation
 * turn boundary instead of in the middle of a tool-use cycle. When the
 * requested start lands inside a cycle, the window is extended backwards to the
 * user turn that triggered it, keeping the whole cycle replayable. If the
 * history itself opens mid-cycle (truncated at the source, so there is no user
 * turn to anchor it), the incomplete cycle is dropped by moving the start
 * forward instead.
 */
export function findSafeWindowStart(messages: BaseMessage[], start: number): number {
	if (start <= 0 || !isPartOfToolCycle(messages[start])) return start;

	// Walk back over the whole cycle region: parallel calls add several
	// consecutive responses, and one user turn can trigger several cycles.
	let cycleStart = start;
	while (cycleStart > 0 && isPartOfToolCycle(messages[cycleStart - 1])) cycleStart--;

	// The region is only replayable together with its user turn, and only if it
	// really starts with the tool call rather than an already orphaned response.
	const userTurn = cycleStart - 1;
	if (userTurn >= 0 && isUserTurn(messages[userTurn]) && isToolCallRequest(messages[cycleStart])) {
		return userTurn;
	}

	let forward = start;
	while (forward < messages.length && isPartOfToolCycle(messages[forward])) forward++;
	return forward;
}

/**
 * Drop-in replacement for BufferWindowMemory with a turn-aware window
 * boundary. The upstream implementation slices the last `k * 2` messages by
 * count alone, which can cut a tool-use cycle in half. Providers such as Gemini
 * validate turn order and reject a history that opens with an unpaired tool
 * response ("function response turn comes immediately after a function call
 * turn") just as much as one that opens with the tool call itself ("function
 * call turn comes immediately after a user turn or after a function response
 * turn"). The boundary is adjusted so cycles are never cut.
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
