import type { BaseMessage } from '@langchain/core/messages';

import { isPartOfToolCycle } from '@utils/messageTurns';

/**
 * Enforces the turn order the Gemini API validates on `contents`:
 *
 * - a `functionCall` turn is only accepted immediately after a user turn or a
 *   `functionResponse` turn;
 * - a `functionResponse` turn is only accepted immediately after the
 *   `functionCall` turn it answers.
 *
 * `@langchain/google-genai` maps messages to `contents` one-to-one (only the
 * system message is lifted out, into `systemInstruction`), so a conversation
 * that opens in the middle of a tool-use cycle reaches the API as a leading
 * `functionCall`/`functionResponse` turn and always fails with a 400 — whatever
 * follows it. This happens whenever the history is cut mid-cycle upstream:
 * context-window truncation, token trimming, or a chat history written by
 * another system.
 *
 * Such a leading cycle has no user turn left to anchor it and is therefore not
 * sendable in any form, so it is dropped up to the first message that can
 * legally open the conversation. Everything else is passed through untouched:
 * histories that already satisfy the contract are returned as-is.
 */
export function dropOrphanedLeadingToolCycle(messages: BaseMessage[]): BaseMessage[] {
	// The system message never reaches `contents`, so the first turn Gemini
	// validates is the first non-system message.
	let head = 0;
	while (head < messages.length && messages[head].getType() === 'system') head++;

	let firstValidTurn = head;
	while (firstValidTurn < messages.length && isPartOfToolCycle(messages[firstValidTurn])) {
		firstValidTurn++;
	}

	if (firstValidTurn === head) return messages;

	// Dropping everything would leave an empty conversation, which is not a
	// request we can make either: let the provider report on the input as given.
	if (firstValidTurn === messages.length) return messages;

	return [...messages.slice(0, head), ...messages.slice(firstValidTurn)];
}
