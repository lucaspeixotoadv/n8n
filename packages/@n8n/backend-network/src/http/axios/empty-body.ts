import type { IHttpRequestOptions, IRequestOptions } from 'n8n-workflow';

/**
 * Methods whose requests do not carry an empty body. Axios serialises an empty
 * string sent as JSON to `""`, so an empty body that stays on the request goes
 * out as two bytes of content, which some servers reject.
 */
const NO_EMPTY_BODY_METHODS = ['GET', 'HEAD', 'OPTIONS', 'DELETE'];

/**
 * Checks whether a request body should be considered empty.
 */
function isEmpty(value: unknown): boolean {
	if (value === null || value === undefined) {
		return true;
	}
	if (typeof value === 'string' || Array.isArray(value) || Buffer.isBuffer(value)) {
		return value.length === 0;
	}
	if (typeof value === 'object') {
		return Object.keys(value).length === 0;
	}
	return false;
}

/** Removes an empty request body on GET, HEAD, OPTIONS, and DELETE requests. */
// oxlint-disable-next-line typescript/no-deprecated
export function removeEmptyBody(requestOptions: IHttpRequestOptions | IRequestOptions) {
	const method = (requestOptions.method ?? 'GET').toUpperCase();
	if (NO_EMPTY_BODY_METHODS.includes(method) && isEmpty(requestOptions.body)) {
		delete requestOptions.body;
	}
}
