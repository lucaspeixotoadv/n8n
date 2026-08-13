import { BufferWindowMemory } from '@langchain/classic/memory';
import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';
import {
	AIMessage,
	HumanMessage,
	SystemMessage,
	ToolMessage,
	isAIMessage,
} from '@langchain/core/messages';
import { loadMemory, saveToMemory } from '@utils/agent-execution';

import { TurnAwareBufferWindowMemory } from '../../../memory/TurnAwareBufferWindowMemory';
import { dropOrphanedLeadingToolCycle } from '../turn-order';

const human = (text: string) => new HumanMessage(text);
const ai = (text: string) => new AIMessage(text);
const toolCall = (...ids: string[]) =>
	new AIMessage({
		content: '',
		tool_calls: ids.map((id) => ({ id, name: 'someTool', args: {}, type: 'tool_call' as const })),
	});
const toolResult = (id: string) =>
	new ToolMessage({ content: 'result', tool_call_id: id, name: 'someTool' });

/**
 * Asserts the ordering rule the Gemini API enforces on `contents`. Messages map
 * one-to-one to turns (the system message is lifted into `systemInstruction`),
 * so it can be checked on the message list itself.
 */
function expectValidGeminiTurnOrder(messages: BaseMessage[]) {
	const turns = messages.filter((message) => message.getType() !== 'system');

	turns.forEach((message, i) => {
		const previous = i > 0 ? turns[i - 1] : undefined;
		const isFunctionResponse = previous?.getType() === 'tool';

		if (isAIMessage(message) && (message.tool_calls?.length ?? 0) > 0) {
			// "function call turn comes immediately after a user turn or after a
			// function response turn"
			expect(previous?.getType() === 'human' || isFunctionResponse).toBe(true);
			return;
		}

		if (message.getType() === 'tool') {
			// "function response turn comes immediately after a function call turn"
			const issuedCall =
				previous !== undefined && isAIMessage(previous) && (previous.tool_calls?.length ?? 0) > 0;
			expect(issuedCall || isFunctionResponse).toBe(true);
		}
	});
}

describe('dropOrphanedLeadingToolCycle', () => {
	it('leaves a conversation without tools untouched', () => {
		const messages = [human('q1'), ai('a1'), human('q2')];

		expect(dropOrphanedLeadingToolCycle(messages)).toBe(messages);
	});

	it('leaves a complete tool-use cycle untouched', () => {
		const messages = [
			new SystemMessage('you are helpful'),
			human('q1'),
			toolCall('call_1'),
			toolResult('call_1'),
			ai('a1'),
			human('q2'),
		];

		expect(dropOrphanedLeadingToolCycle(messages)).toBe(messages);
	});

	it('drops a leading tool call whose user turn was cut off', () => {
		const messages = [toolCall('call_1'), toolResult('call_1'), ai('a1'), human('q2')];

		const result = dropOrphanedLeadingToolCycle(messages);

		expect(result.map((m) => m.getType())).toEqual(['ai', 'human']);
		expectValidGeminiTurnOrder(result);
	});

	it('drops leading orphaned tool responses', () => {
		const messages = [toolResult('call_1'), toolResult('call_2'), ai('a1'), human('q2')];

		const result = dropOrphanedLeadingToolCycle(messages);

		expect(result.map((m) => m.getType())).toEqual(['ai', 'human']);
		expectValidGeminiTurnOrder(result);
	});

	it('drops several leading cycles at once', () => {
		const messages = [
			toolCall('call_1'),
			toolResult('call_1'),
			toolCall('call_2', 'call_3'),
			toolResult('call_2'),
			toolResult('call_3'),
			ai('a1'),
			human('q2'),
		];

		const result = dropOrphanedLeadingToolCycle(messages);

		expect(result.map((m) => m.getType())).toEqual(['ai', 'human']);
		expectValidGeminiTurnOrder(result);
	});

	it('keeps the system message, which never reaches contents', () => {
		const system = new SystemMessage('you are helpful');
		const messages = [system, toolCall('call_1'), toolResult('call_1'), human('q2')];

		const result = dropOrphanedLeadingToolCycle(messages);

		expect(result[0]).toBe(system);
		expect(result.map((m) => m.getType())).toEqual(['system', 'human']);
	});

	it('keeps tool cycles that appear later in the conversation', () => {
		const messages = [
			toolCall('lost_call'),
			toolResult('lost_call'),
			ai('a1'),
			human('q2'),
			toolCall('call_2'),
			toolResult('call_2'),
			ai('a2'),
		];

		const result = dropOrphanedLeadingToolCycle(messages);

		expect(result.map((m) => m.getType())).toEqual(['ai', 'human', 'ai', 'tool', 'ai']);
		expectValidGeminiTurnOrder(result);
	});

	it('leaves the input as given when there is no valid turn left to send', () => {
		const messages = [toolCall('call_1'), toolResult('call_1')];

		expect(dropOrphanedLeadingToolCycle(messages)).toBe(messages);
	});
});

describe('history persisted by the agent and replayed to Gemini', () => {
	async function buildMemory(k: number) {
		const memory = new TurnAwareBufferWindowMemory({
			memoryKey: 'chat_history',
			chatHistory: new InMemoryChatMessageHistory(),
			returnMessages: true,
			inputKey: 'input',
			outputKey: 'output',
			k,
		});

		const step = (id: string) => ({
			action: {
				tool: 'someTool',
				toolInput: {},
				log: `Calling someTool with input: {} (${id})`,
				messageLog: [],
				toolCallId: id,
				type: 'tool_call',
			},
			observation: 'result',
		});

		// Three turns, each one persisted as human → tool call → tool response → answer
		for (const turn of ['1', '2', '3']) {
			await saveToMemory(`q${turn}`, `a${turn}`, memory, [step(`call_${turn}`)], 0);
		}

		return memory;
	}

	it('produces a valid turn order for a truncated multi-turn tool conversation', async () => {
		const memory = await buildMemory(2);

		const chatHistory = (await loadMemory(memory)) ?? [];
		const contents = dropOrphanedLeadingToolCycle([...chatHistory, human('q4')]);

		expect(contents[0].getType()).toBe('human');
		expectValidGeminiTurnOrder(contents);
	});

	it('repairs a history truncated by a memory that is not turn-aware', async () => {
		// Reproduces the reported 400: the window opens on the tool call, so the
		// first turn Gemini sees is a function call with no user turn before it.
		const memory = new BufferWindowMemory({
			memoryKey: 'chat_history',
			chatHistory: new InMemoryChatMessageHistory([
				human('q1'),
				toolCall('call_1', 'call_2'),
				toolResult('call_1'),
				toolResult('call_2'),
				ai('a1'),
				human('q2'),
				toolCall('call_3', 'call_4'),
				toolResult('call_3'),
				toolResult('call_4'),
				ai('a2'),
			]),
			returnMessages: true,
			inputKey: 'input',
			outputKey: 'output',
			k: 2,
		});

		const chatHistory = (await loadMemory(memory)) ?? [];
		expect(isAIMessage(chatHistory[0]) && (chatHistory[0].tool_calls?.length ?? 0) > 0).toBe(true);

		const contents = dropOrphanedLeadingToolCycle([...chatHistory, human('q3')]);

		expect(contents.map((m) => m.getType())).toEqual(['ai', 'human']);
		expectValidGeminiTurnOrder(contents);
	});

	it('stays valid for every context window length', async () => {
		for (let k = 1; k <= 8; k++) {
			const memory = await buildMemory(k);

			const chatHistory = (await loadMemory(memory)) ?? [];
			const contents = dropOrphanedLeadingToolCycle([
				new SystemMessage('you are helpful'),
				...chatHistory,
				human('q4'),
			]);

			expectValidGeminiTurnOrder(contents);
		}
	});
});
