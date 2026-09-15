import type { ModuleInterface } from '@n8n/decorators';
import { BackendModule, OnShutdown } from '@n8n/decorators';
import { Container } from '@n8n/di';

/**
 * Durable suspension of an AI tool call until an external HTTP callback resolves it.
 *
 * The module owns everything about correlating callbacks with parked tool calls: the store,
 * the state machine over it, the endpoint handler, and the resume. It plugs into the rest of
 * n8n through two seams it does not own — the webhook router's tool-callback registry, and
 * the execution context, which carries the registration port to node code.
 */
@BackendModule({ name: 'wait-for-callback' })
export class WaitForCallbackModule implements ModuleInterface {
	async init() {
		const { CallbackWaitDeliveryService } = await import('./callback-wait-delivery.service.js');
		Container.get(CallbackWaitDeliveryService).init();

		const { ToolCallbackWebhookRegistry } = await import(
			'@/webhooks/tool-callback-webhook-registry.js'
		);
		const { ToolCallbackWebhooks } = await import('./tool-callback-webhooks.js');
		Container.get(ToolCallbackWebhookRegistry).register(Container.get(ToolCallbackWebhooks));

		const { CallbackWaitPruningService } = await import('./callback-wait-pruning.service.js');
		Container.get(CallbackWaitPruningService).init();
	}

	@OnShutdown()
	async shutdown() {
		const { CallbackWaitPruningService } = await import('./callback-wait-pruning.service.js');
		Container.get(CallbackWaitPruningService).stopSweeping();
	}

	async entities() {
		const { CallbackWait } = await import('./callback-wait.entity.js');

		return [CallbackWait];
	}

	async context() {
		const { CallbackWaitService } = await import('./callback-wait.service.js');

		return { callbackWaitProvider: Container.get(CallbackWaitService) };
	}
}
