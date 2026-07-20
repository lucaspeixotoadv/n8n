import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessageChunk } from '@langchain/core/messages';
import { mock } from 'vitest-mock-extended';

import { LLM_SYSTEM_RULES, LLM_SYSTEM_RULES_WITH_REASON, runLLMValidation } from '../model';

describe('Guardrail Model Helpers', () => {
	describe('Output Format Validation', () => {
		it('should validate output contains only expected fields', async () => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({
					content: JSON.stringify({
						confidenceScore: 0.5,
						flagged: false,
					}),
				}),
			);

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			expect(result.tripwireTriggered).toBe(false);
			expect(result.confidenceScore).toBe(0.5);
			expect(result.executionFailed).toBe(false);
		});

		it('should reject output with extra fields', async () => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({
					content: JSON.stringify({
						confidenceScore: 0.3,
						flagged: false,
						extraField: 'should not be here',
					}),
				}),
			);

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			// Should fail due to strict schema validation
			expect(result.executionFailed).toBe(true);
			expect(result.tripwireTriggered).toBe(true);
		});

		it('should reject output with renamed fields', async () => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({
					content: JSON.stringify({
						score: 0.3,
						isViolation: false,
					}),
				}),
			);

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			// Should fail due to missing required fields
			expect(result.executionFailed).toBe(true);
			expect(result.tripwireTriggered).toBe(true);
		});

		it('should handle complex nested response structures', async () => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({
					content: JSON.stringify({
						analysis: {
							confidenceScore: 0.8,
							flagged: true,
						},
						confidenceScore: 0.2,
						flagged: false,
					}),
				}),
			);

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			// Should fail due to extra nested fields
			expect(result.executionFailed).toBe(true);
		});

		it('should validate field types are correct', async () => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({
					content: JSON.stringify({
						confidenceScore: '0.5',
						flagged: 'false',
					}),
				}),
			);

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			// Should fail due to incorrect types
			expect(result.executionFailed).toBe(true);
		});

		it('should correctly evaluate confidence threshold', async () => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({
					content: JSON.stringify({
						confidenceScore: 0.8,
						flagged: true,
					}),
				}),
			);

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			expect(result.tripwireTriggered).toBe(true);
			expect(result.confidenceScore).toBe(0.8);
			expect(result.executionFailed).toBe(false);
		});

		it('should not trigger when confidence is below threshold', async () => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({
					content: JSON.stringify({
						confidenceScore: 0.6,
						flagged: true,
					}),
				}),
			);

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			expect(result.tripwireTriggered).toBe(false);
			expect(result.confidenceScore).toBe(0.6);
		});

		it('should require both flagged and threshold conditions', async () => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({
					content: JSON.stringify({
						confidenceScore: 0.9,
						flagged: false,
					}),
				}),
			);

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			// High confidence but not flagged = should not trigger
			expect(result.tripwireTriggered).toBe(false);
		});
	});

	describe('Violation Reason', () => {
		const mockModelResponse = (response: Record<string, unknown>) => {
			const mockModel = mock<BaseChatModel>();
			mockModel.invoke.mockResolvedValue(
				new AIMessageChunk({ content: JSON.stringify(response) }),
			);
			return mockModel;
		};

		it('should return the reason when enabled and the guardrail is triggered', async () => {
			const mockModel = mockModelResponse({
				confidenceScore: 0.9,
				flagged: true,
				reason: 'The input requests restricted content',
			});

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
				includeReason: true,
			});

			expect(result.tripwireTriggered).toBe(true);
			expect(result.executionFailed).toBe(false);
			expect(result.reason).toBe('The input requests restricted content');
		});

		it('should fail when enabled and the model omits the reason on a flagged input', async () => {
			const mockModel = mockModelResponse({ confidenceScore: 0.9, flagged: true });

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
				includeReason: true,
			});

			expect(result.executionFailed).toBe(true);
			expect(result.tripwireTriggered).toBe(true);
		});

		it('should pass without a reason when enabled and the input is not flagged', async () => {
			const mockModel = mockModelResponse({ confidenceScore: 0.1, flagged: false });

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
				includeReason: true,
			});

			expect(result.tripwireTriggered).toBe(false);
			expect(result.executionFailed).toBe(false);
			expect(result.reason).toBeUndefined();
		});

		it('should not expose the reason when flagged but below the threshold', async () => {
			const mockModel = mockModelResponse({
				confidenceScore: 0.5,
				flagged: true,
				reason: 'Borderline case',
			});

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
				includeReason: true,
			});

			expect(result.tripwireTriggered).toBe(false);
			expect(result.reason).toBeUndefined();
		});

		it('should reject a reason field when the option is disabled', async () => {
			const mockModel = mockModelResponse({
				confidenceScore: 0.9,
				flagged: true,
				reason: 'Unexpected field',
			});

			const result = await runLLMValidation('test-guardrail', 'test input', {
				model: mockModel,
				prompt: 'Test prompt',
				threshold: 0.7,
			});

			// Should fail due to strict schema validation
			expect(result.executionFailed).toBe(true);
		});

		it('should describe the reason field only in the reason variant of the system rules', () => {
			expect(LLM_SYSTEM_RULES).not.toContain('"reason"');
			expect(LLM_SYSTEM_RULES).toContain('Return exactly two fields');
			expect(LLM_SYSTEM_RULES_WITH_REASON).toContain('"reason"');
			expect(LLM_SYSTEM_RULES_WITH_REASON).toContain('omit the "reason" field');
		});
	});
});
