import type {
	CallbackWaitProvider,
	CallbackWaitRegistration,
	IWorkflowExecuteAdditionalData,
} from 'n8n-workflow';
import { mock } from 'vitest-mock-extended';

import { getCallbackWaitHelperFunctions } from '../callback-wait-helper-functions';

const registration: CallbackWaitRegistration = {
	namespace: 'endpoint-a',
	correlationValue: '125',
	executionId: 'exec-1',
	nodeId: 'node-1',
};

describe('getCallbackWaitHelperFunctions', () => {
	it('grants nothing when no backend is wired', () => {
		expect(getCallbackWaitHelperFunctions(mock<IWorkflowExecuteAdditionalData>({}))).toEqual({});
	});

	it('registers the wait as the user the run is started as', async () => {
		const provider = mock<CallbackWaitProvider>();
		provider.registerWait.mockResolvedValue({ status: 'registered' });
		const additionalData = mock<IWorkflowExecuteAdditionalData>({
			userId: 'user-1',
			'wait-for-callback': { callbackWaitProvider: provider },
		});

		const { registerCallbackWait } = getCallbackWaitHelperFunctions(additionalData);
		await registerCallbackWait!(registration);

		// The node cannot know who started the run; the runtime can, and the resumed
		// segment has to run as that user to be pushed to the UI as this one is.
		expect(provider.registerWait).toHaveBeenCalledWith({ ...registration, userId: 'user-1' });
	});

	it('registers a run that no user started without one', async () => {
		const provider = mock<CallbackWaitProvider>();
		provider.registerWait.mockResolvedValue({ status: 'registered' });
		const additionalData = mock<IWorkflowExecuteAdditionalData>({
			userId: undefined,
			'wait-for-callback': { callbackWaitProvider: provider },
		});

		await getCallbackWaitHelperFunctions(additionalData).registerCallbackWait!(registration);

		expect(provider.registerWait.mock.calls[0][0].userId).toBeUndefined();
	});
});
