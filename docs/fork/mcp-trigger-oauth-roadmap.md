# Roadmap: OAuth discovery for the MCP Server Trigger with JWT Auth (fork)

Status: not started. This document describes the planned change and the code that it builds on.

## Goal

A generic MCP client (for example Claude.ai) connects directly to an MCP Server Trigger in this fork. The client
discovers the authorization server, the person signs in there, and the client sends an access token on each
request. The authorization server is an external system (Chatwoot), not n8n. The trigger identifies the person
from the token. The trigger does not link the token to an n8n user.

## Current state (n8n@2.46.4.1.8)

- The MCP Server Trigger has the authentication option `jwtAuth` (from node version 2.1).
  - It verifies `Authorization: Bearer <JWT>` with the `jwtAuth` credential (PEM public key, fixed algorithm).
  - It checks the issuer (`jwtIssuer`), the audience (the exact URL of the trigger, `jwtCheckAudience`) and the
    maximum token age (`jwtMaxAge`).
  - It gives the verified claims to the tools as `jwtPayload`.
  - Code: `packages/@n8n/nodes-langchain/nodes/mcp/McpTrigger/McpTrigger.node.ts` (`getJwtClaimChecks`) and
    `packages/nodes-base/nodes/Webhook/utils.ts` (`validateWebhookAuthentication`, the `jwtAuth` branch).
- The trigger does the authentication on every request (setup, message, DELETE) before any other work.
- The `authorization` header is marked as consumed (`recordConsumedAuth`), so `redactedHeaders` hides it from the
  tools and from the execution data.
- Chatwoot already issues a JWT for each request (ES256, `iss`, `aud` = the server URL, `exp` = 2 minutes, the
  person in `sub`, `name`, `email`, `actor_type`, `account`, `via`). Chatwoot uses it as the client: it is the
  issuer and the caller at the same time. This works because Chatwoot is the only caller of the JWT trigger.

## What is missing for a generic client

A generic client cannot find out where to get a token:

1. The trigger does not publish RFC 9728 protected-resource metadata for a `jwtAuth` trigger.
2. On 401, the `jwtAuth` branch does not send `WWW-Authenticate: Bearer resource_metadata="..."`.
3. The public key is a static PEM in the credential. Key rotation is manual. A JWKS URL from the issuer is not
   supported in the `jwtAuth` credential.

## How n8n does discovery today

- Route: `packages/cli/src/modules/oauth-server/oauth.controller.ts`, `GET /.well-known/oauth-protected-resource/*resourcePath`.
  It resolves the resource through `ProtectedResourceRegistry.getByResourcePath`
  (`packages/@n8n/backend-services/src/services/protected-resource.registry.ts`) and builds the metadata in
  `buildProtectedResourceMetadata`: `resource`, `bearer_methods_supported`, `authorization_servers`,
  `scopes_supported`.
- Resolver for MCP triggers:
  `packages/cli/src/modules/oauth-server/protected-resource-resolvers/workflow-mcp-trigger-resource.resolver.ts`.
  It returns a resource only when the active version of the node has `authentication === 'n8nOAuth2'`.
- `authorization_servers` for a trigger comes from `AuthenticationService.advertise`
  (`packages/cli/src/modules/inbound-auth-core/authentication.service.ts`). For a trusted source of type `oauth2`,
  `Oauth2BearerDriver.advertise` (`oauth2-bearer.driver.ts`) returns the source issuer and the
  `WWW-Authenticate` challenge with the metadata URL.
- The `n8nOAuth2` branch of the trigger sends the challenge on 401 through `n8nOAuth2Auth`
  (`packages/workflow/src/n8n-oauth2-auth.ts`).

## Two paths

### Path A: trusted source (native n8n pipeline). Not recommended.

Use `authentication = n8nOAuth2` with a trusted source of type `oauth2` whose issuer is Chatwoot. Discovery,
JWKS fetch and token checks already exist (`Oauth2BearerDriver.verify` reads the JWKS from the source metadata).

Reasons not to use it, found in the test of 18/11/2026:

- The pipeline links each token to an n8n user (`establishTriggerIdentity`). Each person and each assistant in
  Chatwoot needs an n8n account. The name comes from the n8n account (empty for an invited user). The instance
  owner cannot be linked (`link-refused`).
- The trusted-source management API is gated by `@Licensed('feat:trustedSourceManage')` and ships dark behind
  `N8N_ENV_FEAT_TRUSTED_SOURCES_API_ENABLED`.
- A trigger accepts one trusted source.

### Path B: discovery for the `jwtAuth` trigger. Recommended.

Keep the verification of the `jwtAuth` branch and add discovery to it.

1. Node parameter on the MCP Server Trigger, shown only with `jwtAuth`: `jwtAuthorizationServer` (the issuer URL of
   the authorization server). Empty means no discovery, as today.
2. Resolver: extend `WorkflowMcpTriggerResourceResolver.resolveByPath` (or add a resolver next to it) for an active,
   enabled MCP trigger with `authentication === 'jwtAuth'` and a non-empty `jwtAuthorizationServer`.
   - Resource URL and audience: the same URL that `getJwtClaimChecks` uses (`getWebhookResourceUrl('default')`).
     Use one helper for both, so that the metadata and the audience check cannot drift.
   - The resource must not join the trusted-source pipeline: no `getAcceptedSourceIds`, and
     `buildProtectedResourceMetadata` must return `authorization_servers: [jwtAuthorizationServer]` for it.
     Today that function returns the instance base URL for a resource outside the pipeline. Add an explicit field
     on the resource for an external authorization server. Do not use a special case in the controller.
3. Challenge: when `jwtAuthorizationServer` is set, the `jwtAuth` branch of the trigger sends
   `WWW-Authenticate: Bearer resource_metadata="<origin>/.well-known/oauth-protected-resource<path>"` with a
   missing token and with a token that is not valid. Use the same URL builder as `Oauth2BearerDriver.advertise`.
   - Today a missing token gets 401 and a token that is not valid gets 403. The MCP authorization specification
     and RFC 6750 ask for 401 with `error="invalid_token"` for an expired or invalid token. Change it to 401 only
     for a trigger with `jwtAuthorizationServer`, so that the current behavior of the other `jwtAuth` triggers and
     of the Webhook node does not change.
   - A credential set up incorrectly keeps status 500.
4. Optional: a `jwksUrl` option in the `jwtAuth` credential, as an alternative to the PEM key, with a cached fetch
   and a fixed algorithm. This makes key rotation automatic. Reuse the JWK conversion of `Oauth2BearerDriver`
   (`getPublicKeyFromJwk`) if it is exportable. Do not copy it.
5. Tests: the resolver (`jwtAuth` with and without `jwtAuthorizationServer`, inactive workflow, disabled node), the
   metadata document, the 401 challenge, and that the audience in the metadata and in the check are the same.

### What Chatwoot provides (outside this repository)

- Authorization server metadata (RFC 8414) at its issuer, the authorization and token endpoints with PKCE, and
  dynamic client registration for clients such as Claude.ai.
- Access tokens as JWT, signed with the same installation key (or published in a JWKS), with `iss`,
  `aud` = the resource URL from the RFC 8707 `resource` parameter, `exp`, the person claims of today, and the
  client that acts for the person (for example `client_id` and a client name).

### What changes in the n8n-workflows repository

- `[CHATWOOT] Quem pediu` (`zdyxTFyHv7Blacad`) reads the client claim, so that the mark says which application
  acted for the person ("a pedido de Maria Souza, pelo Claude"). The rest of the chain (`jwtPayload` →
  `quemPediu` → mark) does not change.

## Order

1. Chatwoot: authorization server.
2. Fork: path B, steps 1 to 3 and 5. Release with a new tag.
3. n8n-workflows: set `jwtAuthorizationServer` on the Chatwoot trigger of each MCP server; update `Quem pediu`.
4. Optional: step 4 (JWKS).
