import {
	MAX_CALLBACK_CORRELATION_LENGTH,
	normalizeCallbackCorrelationValue,
} from '../src/callback-correlation';

describe('normalizeCallbackCorrelationValue', () => {
	test.each([
		['a string', 'ticket-1', 'ticket-1'],
		['a number', 42, '42'],
		['a boolean', true, 'true'],
		['surrounding whitespace', '  ticket-1\n', 'ticket-1'],
		[
			'a value at the length limit',
			'x'.repeat(MAX_CALLBACK_CORRELATION_LENGTH),
			'x'.repeat(MAX_CALLBACK_CORRELATION_LENGTH),
		],
	])('accepts %s', (_label, value, expected) => {
		expect(normalizeCallbackCorrelationValue(value)).toBe(expected);
	});

	test.each([
		['null', null],
		['undefined', undefined],
		['an empty string', ''],
		['only whitespace', '   '],
		['an object', { id: 'ticket-1' }],
		['an array', ['ticket-1']],
		['a value past the length limit', 'x'.repeat(MAX_CALLBACK_CORRELATION_LENGTH + 1)],
	])('rejects %s', (_label, value) => {
		expect(normalizeCallbackCorrelationValue(value)).toBeNull();
	});

	test('keeps two values that differ only by whitespace equal', () => {
		expect(normalizeCallbackCorrelationValue(' ticket-1 ')).toBe(
			normalizeCallbackCorrelationValue('ticket-1'),
		);
	});
});
