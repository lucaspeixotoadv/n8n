import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { BaseMessage } from '@langchain/core/messages';
import type { ChatGeneration, ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { OperationalError } from 'n8n-workflow';

import { dropOrphanedLeadingToolCycle } from './turn-order';

const MALFORMED_FUNCTION_CALL_FINISH_REASON = 'MALFORMED_FUNCTION_CALL';

/** Total attempts per model call, including the initial one. */
export const MAX_MALFORMED_FUNCTION_CALL_ATTEMPTS = 3;

function findMalformedFunctionCallGeneration(result: ChatResult): ChatGeneration | undefined {
	return result.generations.find((generation) => {
		const finishReason: unknown = generation.generationInfo?.finishReason;
		return finishReason === MALFORMED_FUNCTION_CALL_FINISH_REASON;
	});
}

function getFinishMessage(generation: ChatGeneration | undefined): string | undefined {
	const finishMessage: unknown = generation?.generationInfo?.finishMessage;
	return typeof finishMessage === 'string' ? finishMessage : undefined;
}

/**
 * Adapts a conversation to the two things Gemini enforces beyond the generic chat contract:
 *
 * - **Turn order.** Every request is aligned to Gemini's `contents` ordering rules before it
 *   is sent (see {@link dropOrphanedLeadingToolCycle}). This is the provider boundary, so it
 *   covers any history reaching the model — memory nodes, trimming, or an externally written
 *   chat history — without the ordering rule leaking into the agent's generic abstractions.
 *
 * - **Malformed function calls.** Gemini intermittently fails to emit a parseable function call
 *   and instead finishes with `finishReason: MALFORMED_FUNCTION_CALL`, often printing the
 *   intended call as plain text. `@langchain/google-genai` maps such a response to a regular
 *   text generation without `tool_calls`, so agents would silently treat the printed
 *   pseudo-call as the final answer. Retrying the request is safe — the function call never
 *   parsed, so no tool was executed — and usually succeeds. After the attempts are exhausted a
 *   clear error is thrown instead of leaking the malformed text downstream.
 */
export class N8nChatGoogleGenerativeAI extends ChatGoogleGenerativeAI {
	async _generate(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		const contents = dropOrphanedLeadingToolCycle(messages);
		let malformedGeneration: ChatGeneration | undefined;

		for (let attempt = 1; attempt <= MAX_MALFORMED_FUNCTION_CALL_ATTEMPTS; attempt++) {
			const result = await super._generate(contents, options, runManager);

			malformedGeneration = findMalformedFunctionCallGeneration(result);
			if (!malformedGeneration) return result;
		}

		const finishMessage = getFinishMessage(malformedGeneration);
		throw new OperationalError(
			`Gemini did not return a valid tool call (finishReason: ${MALFORMED_FUNCTION_CALL_FINISH_REASON}) after ${MAX_MALFORMED_FUNCTION_CALL_ATTEMPTS} attempts`,
			{
				description:
					(finishMessage ? `${finishMessage}. ` : '') +
					'This is usually a transient model issue. Retrying the execution often helps; if it persists, try simplifying the connected tools or their parameter schemas.',
			},
		);
	}

	async *_streamResponseChunks(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): AsyncGenerator<ChatGenerationChunk> {
		yield* super._streamResponseChunks(dropOrphanedLeadingToolCycle(messages), options, runManager);
	}
}
