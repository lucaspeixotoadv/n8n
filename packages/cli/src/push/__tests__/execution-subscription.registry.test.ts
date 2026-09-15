import { ExecutionSubscriptionRegistry } from '@/push/execution-subscription.registry';

describe('ExecutionSubscriptionRegistry', () => {
	let registry: ExecutionSubscriptionRegistry;

	beforeEach(() => {
		registry = new ExecutionSubscriptionRegistry();
	});

	it('reports the sessions watching an execution', () => {
		registry.subscribe('exec-1', 'ref-a');
		registry.subscribe('exec-1', 'ref-b');

		expect(registry.subscribersOf('exec-1').sort()).toEqual(['ref-a', 'ref-b']);
	});

	it('reports nobody for an execution nobody is watching', () => {
		expect(registry.subscribersOf('exec-1')).toEqual([]);
		expect(registry.hasSubscribers('exec-1')).toBe(false);
	});

	it('keeps one session watching several executions apart', () => {
		registry.subscribe('exec-1', 'ref-a');
		registry.subscribe('exec-2', 'ref-a');

		registry.unsubscribe('exec-1', 'ref-a');

		expect(registry.subscribersOf('exec-1')).toEqual([]);
		expect(registry.subscribersOf('exec-2')).toEqual(['ref-a']);
	});

	it('counts a repeated subscription once', () => {
		registry.subscribe('exec-1', 'ref-a');
		registry.subscribe('exec-1', 'ref-a');

		expect(registry.subscribersOf('exec-1')).toEqual(['ref-a']);
	});

	it('releases everything a disconnected session was watching', () => {
		registry.subscribe('exec-1', 'ref-a');
		registry.subscribe('exec-2', 'ref-a');
		registry.subscribe('exec-1', 'ref-b');

		registry.unsubscribeAll('ref-a');

		expect(registry.subscribersOf('exec-1')).toEqual(['ref-b']);
		expect(registry.subscribersOf('exec-2')).toEqual([]);
	});

	it('tolerates unsubscribing something that was never subscribed', () => {
		expect(() => registry.unsubscribe('exec-1', 'ref-a')).not.toThrow();
		expect(() => registry.unsubscribeAll('ref-a')).not.toThrow();
	});
});
