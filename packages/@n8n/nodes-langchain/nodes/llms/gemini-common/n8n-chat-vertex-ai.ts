import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import type { ChatGenerationChunk, ChatResult } from '@langchain/core/outputs';
import { ChatVertexAI } from '@langchain/google-vertexai';

import { rewriteForeignTurns, toTextAndToolCalls } from './foreign-turns';

/** The `model_provider` that `@langchain/google-common` sets on its own messages. */
const VERTEX_MODEL_PROVIDER = 'google-vertexai';

/**
 * The thought signature that Google documents for a function call that Gemini did
 * not generate. Gemini 3 models reject a function call without a thought signature.
 */
const NON_GEMINI_THOUGHT_SIGNATURE = 'skip_thought_signature_validator';

/**
 * Makes a Gemini turn from a turn of another provider. `@langchain/google-common`
 * reads the thought signatures from `additional_kwargs.signatures`, one for each
 * part in order: the text parts, then the function calls. Gemini reads the
 * signature of the first function call of a turn.
 */
function toVertexTurn(turn: AIMessage): AIMessage {
	const fields = toTextAndToolCalls(turn);
	if (fields.tool_calls.length === 0) return new AIMessage(fields);

	const signatures = [
		...fields.content.map(() => ''),
		NON_GEMINI_THOUGHT_SIGNATURE,
		...fields.tool_calls.slice(1).map(() => ''),
	];
	return new AIMessage({ ...fields, additional_kwargs: { signatures } });
}

function toVertexHistory(messages: BaseMessage[]): BaseMessage[] {
	return rewriteForeignTurns(messages, VERTEX_MODEL_PROVIDER, toVertexTurn);
}

/**
 * Adapts a conversation to Gemini on Vertex AI. A model fallback puts the turns of
 * another model into the history. They are rewritten into text and tool calls (see
 * {@link rewriteForeignTurns}).
 */
export class N8nChatVertexAI extends ChatVertexAI {
	async _generate(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): Promise<ChatResult> {
		return await super._generate(toVertexHistory(messages), options, runManager);
	}

	async *_streamResponseChunks(
		messages: BaseMessage[],
		options: this['ParsedCallOptions'],
		runManager?: CallbackManagerForLLMRun,
	): AsyncGenerator<ChatGenerationChunk> {
		yield* super._streamResponseChunks(toVertexHistory(messages), options, runManager);
	}
}
