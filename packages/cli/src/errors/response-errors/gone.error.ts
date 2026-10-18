import { ResponseError } from '@n8n/errors';

export class GoneError extends ResponseError {
	constructor(message: string, hint: string | undefined = undefined) {
		super(message, 410, 410, hint);
	}
}
