import { InMemoryChatMessageHistory } from '@langchain/core/chat_history';
import type { BaseMessage } from '@langchain/core/messages';
import { AIMessage, HumanMessage, ToolMessage, isAIMessage } from '@langchain/core/messages';

import { findSafeWindowStart, TurnAwareBufferWindowMemory } from '../TurnAwareBufferWindowMemory';

const human = (text: string) => new HumanMessage(text);
const ai = (text: string) => new AIMessage(text);
const toolCall = (...ids: string[]) =>
	new AIMessage({
		content: '',
		tool_calls: ids.map((id) => ({ id, name: 'someTool', args: {}, type: 'tool_call' as const })),
	});
const toolResult = (id: string) =>
	new ToolMessage({ content: 'result', tool_call_id: id, name: 'someTool' });

async function loadWindow(messages: BaseMessage[], k: number): Promise<BaseMessage[]> {
	const chatHistory = new InMemoryChatMessageHistory(messages);
	const memory = new TurnAwareBufferWindowMemory({
		memoryKey: 'chat_history',
		chatHistory,
		returnMessages: true,
		inputKey: 'input',
		outputKey: 'output',
		k,
	});
	return (await memory.loadMemoryVariables({})).chat_history as BaseMessage[];
}

/**
 * Mirrors the turn ordering enforced by the Gemini API: a tool call may only
 * follow a user turn or a tool response, and a tool response may only follow
 * the AI message that issued the matching call.
 */
function expectValidToolOrdering(messages: BaseMessage[]) {
	messages.forEach((message, i) => {
		const isToolCall = isAIMessage(message) && (message.tool_calls?.length ?? 0) > 0;
		if (isToolCall) {
			expect(i).toBeGreaterThan(0);
			const previous = messages[i - 1];
			expect(previous.getType() === 'human' || previous.getType() === 'tool').toBe(true);
			return;
		}

		if (message.getType() !== 'tool') return;
		const toolCallId = (message as ToolMessage).tool_call_id;
		let head = i;
		while (head > 0 && messages[head - 1].getType() === 'tool') head--;
		expect(head).toBeGreaterThan(0);
		const issuer = messages[head - 1];
		expect(isAIMessage(issuer)).toBe(true);
		expect((issuer as AIMessage).tool_calls?.map((tc) => tc.id)).toContain(toolCallId);
	});
}

describe('findSafeWindowStart', () => {
	it('keeps the start when it does not land inside a tool-use cycle', () => {
		const messages = [human('a'), ai('b'), human('c'), ai('d')];
		expect(findSafeWindowStart(messages, 2)).toBe(2);
		expect(findSafeWindowStart(messages, 0)).toBe(0);
	});

	it('extends backwards to the user turn that triggered an orphaned response', () => {
		const messages = [human('a'), toolCall('1'), toolResult('1'), ai('b')];
		expect(findSafeWindowStart(messages, 2)).toBe(0);
	});

	it('extends backwards to the user turn when the start lands on the tool call itself', () => {
		const messages = [human('a'), toolCall('1'), toolResult('1'), ai('b')];
		expect(findSafeWindowStart(messages, 1)).toBe(0);
	});

	it('walks back over consecutive responses from parallel tool calls', () => {
		const messages = [human('a'), toolCall('1', '2'), toolResult('1'), toolResult('2'), ai('b')];
		expect(findSafeWindowStart(messages, 3)).toBe(0);
	});

	it('walks back over several cycles triggered by the same user turn', () => {
		const messages = [
			human('a'),
			toolCall('1'),
			toolResult('1'),
			toolCall('2'),
			toolResult('2'),
			ai('b'),
		];
		expect(findSafeWindowStart(messages, 3)).toBe(0);
		expect(findSafeWindowStart(messages, 4)).toBe(0);
	});

	it('moves forward past tool responses that have no matching call', () => {
		const messages = [human('a'), toolResult('1'), toolResult('2'), ai('b'), human('c'), ai('d')];
		expect(findSafeWindowStart(messages, 2)).toBe(3);
	});

	it('moves forward when the history itself opens mid-cycle', () => {
		const messages = [toolCall('1'), toolResult('1'), ai('b'), human('c'), ai('d')];
		expect(findSafeWindowStart(messages, 1)).toBe(2);
	});
});

describe('TurnAwareBufferWindowMemory', () => {
	it('behaves like the upstream slice when no cycle is cut', async () => {
		const messages = [human('q1'), ai('a1'), human('q2'), ai('a2'), human('q3'), ai('a3')];
		const window = await loadWindow(messages, 2);
		expect(window.map((m) => m.content)).toEqual(['q2', 'a2', 'q3', 'a3']);
	});

	it('returns the full history when it is shorter than the window', async () => {
		const messages = [human('q1'), ai('a1')];
		const window = await loadWindow(messages, 5);
		expect(window).toHaveLength(2);
	});

	it('never starts the window with an unpaired tool response', async () => {
		// slice(-k * 2) with k = 1 would start exactly on the tool response,
		// which Gemini rejects with a 400 ("function response turn comes
		// immediately after a function call turn")
		const messages = [human('q1'), toolCall('call_1'), toolResult('call_1'), ai('a1')];
		const window = await loadWindow(messages, 1);

		expect(window.map((m) => m.getType())).toEqual(['human', 'ai', 'tool', 'ai']);
		expectValidToolOrdering(window);
	});

	it('never starts the window with a tool call', async () => {
		// Regression: keeping the cycle intact by starting on the tool call turns
		// the error above into its mirror image — Gemini rejects a history that
		// opens with a function call with a 400 ("function call turn comes
		// immediately after a user turn or after a function response turn")
		const messages = [
			human('q1'),
			ai('a1'),
			human('q2'),
			toolCall('call_1'),
			toolResult('call_1'),
			ai('a2'),
			human('q3'),
		];
		// k = 2 → slice would start exactly on the tool call
		const window = await loadWindow(messages, 2);

		expect(window.map((m) => m.getType())).toEqual(['human', 'ai', 'tool', 'ai', 'human']);
		expectValidToolOrdering(window);
	});

	it('keeps parallel tool call batches intact', async () => {
		const messages = [
			human('q1'),
			ai('a1'),
			human('q2'),
			toolCall('call_1', 'call_2'),
			toolResult('call_1'),
			toolResult('call_2'),
			ai('a2'),
		];
		// k = 1 → slice would start on the second tool response
		const window = await loadWindow(messages, 1);

		expect(window.map((m) => m.getType())).toEqual(['human', 'ai', 'tool', 'tool', 'ai']);
		expectValidToolOrdering(window);
	});

	it('keeps several tool cycles of the same turn intact', async () => {
		const messages = [
			human('q1'),
			ai('a1'),
			human('q2'),
			toolCall('call_1'),
			toolResult('call_1'),
			toolCall('call_2'),
			toolResult('call_2'),
			ai('a2'),
		];
		const window = await loadWindow(messages, 2);

		expect(window.map((m) => m.getType())).toEqual(['human', 'ai', 'tool', 'ai', 'tool', 'ai']);
		expectValidToolOrdering(window);
	});

	it('stays valid at every possible cut point of a tool-use conversation', async () => {
		const messages = [
			human('q1'),
			toolCall('call_1'),
			toolResult('call_1'),
			ai('a1'),
			human('q2'),
			toolCall('call_2', 'call_3'),
			toolResult('call_2'),
			toolResult('call_3'),
			ai('a2'),
			human('q3'),
			ai('a3'),
		];
		for (let k = 1; k <= 6; k++) {
			const window = await loadWindow(messages, k);
			expect(window.length).toBeGreaterThan(0);
			expect(window[0].getType()).not.toBe('tool');
			expect(isAIMessage(window[0]) && (window[0].tool_calls?.length ?? 0) > 0).toBe(false);
			expectValidToolOrdering(window);
		}
	});

	it('drops orphaned tool responses when the history has no matching call', async () => {
		const messages = [human('q1'), toolResult('lost_call'), ai('a1'), human('q2'), ai('a2')];
		// k = 2 → slice would start on the orphaned tool response
		const window = await loadWindow(messages, 2);

		expect(window.map((m) => m.getType())).toEqual(['ai', 'human', 'ai']);
	});

	it('drops a leading cycle whose user turn is already gone from the history', async () => {
		const messages = [
			toolCall('lost_call'),
			toolResult('lost_call'),
			ai('a1'),
			human('q2'),
			ai('a2'),
		];
		const window = await loadWindow(messages, 2);

		expect(window.map((m) => m.getType())).toEqual(['ai', 'human', 'ai']);
		expectValidToolOrdering(window);
	});
});
