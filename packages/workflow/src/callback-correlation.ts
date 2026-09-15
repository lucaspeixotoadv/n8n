/**
 * The shared correlation contract between a tool call that registers a callback wait and
 * the runtime that matches an incoming callback against it. Both sides must agree
 * byte-for-byte, so the rule lives here rather than in either of them.
 */

/**
 * Longest correlation value the store accepts. Callbacks are unauthenticated-by-default
 * external traffic, so the bound is enforced on both sides: a wait that would exceed it is
 * refused loudly, and a callback carrying an oversized id simply matches nothing.
 */
export const MAX_CALLBACK_CORRELATION_LENGTH = 255;

/**
 * The stored form of a correlation id, or `null` when the value cannot be one.
 *
 * Normalisation is deliberately shallow. Making `125` and `"125"` the same wait removes an
 * artificial mismatch between a JSON number and the string a model produced. Anything
 * beyond that — case folding, stripping punctuation, unwrapping prefixes — would silently
 * merge ids the external system considers distinct, which is a wrong resume rather than a
 * missing one.
 */
export function normalizeCallbackCorrelationValue(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'object') return null;

	const normalized = String(value).trim();
	if (normalized.length === 0) return null;
	if (normalized.length > MAX_CALLBACK_CORRELATION_LENGTH) return null;

	return normalized;
}
