import { ControllerRegistryMetadata } from '@n8n/decorators';
import { Container } from '@n8n/di';

import { TrustedSourceController } from '../trusted-source.controller';

describe('TrustedSourceController', () => {
	const metadata = Container.get(ControllerRegistryMetadata).getControllerMetadata(
		TrustedSourceController as never,
	);
	const routes = Array.from(metadata.routes.values())
		.map((route) => ({
			route: `${route.method.toUpperCase()} ${route.path}`,
			scope: route.accessScope?.scope,
			globalOnly: route.accessScope?.globalOnly,
			licenseFeature: route.licenseFeature,
		}))
		.sort((a, b) => a.route.localeCompare(b.route));

	it('is mounted at /trusted-sources', () => {
		expect(metadata.basePath).toBe('/trusted-sources');
	});

	// Every route needs a global trustedSource scope. No route needs a license feature.
	it('gates each route with a global scope and no license feature', () => {
		expect(routes).toEqual([
			{
				route: 'DELETE /:id',
				scope: 'trustedSource:delete',
				globalOnly: true,
				licenseFeature: undefined,
			},
			{ route: 'GET /', scope: 'trustedSource:list', globalOnly: true, licenseFeature: undefined },
			{
				route: 'GET /:id',
				scope: 'trustedSource:read',
				globalOnly: true,
				licenseFeature: undefined,
			},
			{
				route: 'PATCH /:id',
				scope: 'trustedSource:update',
				globalOnly: true,
				licenseFeature: undefined,
			},
			{
				route: 'POST /',
				scope: 'trustedSource:create',
				globalOnly: true,
				licenseFeature: undefined,
			},
			{
				route: 'POST /:id/check',
				scope: 'trustedSource:update',
				globalOnly: true,
				licenseFeature: undefined,
			},
		]);
	});
});
