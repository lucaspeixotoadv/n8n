import type {
	CallbackWaitFunctions,
	CallbackWaitRegistration,
	IWorkflowExecuteAdditionalData,
} from 'n8n-workflow';

/**
 * Exposes the callback-correlation backend to node code, mirroring how other backend
 * capabilities reach nodes. Returns nothing when no backend is wired, which leaves the
 * helper `undefined` so a node can report the capability as unavailable instead of
 * silently parking an execution nothing can ever wake.
 */
export function getCallbackWaitHelperFunctions(
	additionalData: IWorkflowExecuteAdditionalData,
): Partial<CallbackWaitFunctions> {
	const provider = additionalData['wait-for-callback']?.callbackWaitProvider;
	if (!provider) return {};

	return {
		// The node knows nothing about who started the run; the runtime does. Carrying the
		// user over is what lets the resumed segment be pushed to the UI as this one is.
		registerCallbackWait: async (registration: CallbackWaitRegistration) =>
			await provider.registerWait({
				userId: additionalData.userId,
				...registration,
			}),
	};
}
