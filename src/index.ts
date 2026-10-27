/**
 * Garmin Personal API → MCP connector on Cloudflare Workers.
 *
 * One Worker is both the OAuth authorization server (so claude.ai can connect with a normal
 * sign-in flow) and the protected MCP endpoint at /mcp.
 */
import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { defaultHandler, SCOPE } from './auth';
import type { Env } from './env';
import { handleMcp } from './mcp';

const mcpHandler: ExportedHandler<Env> & Required<Pick<ExportedHandler<Env>, 'fetch'>> = {
  // Reached only with a valid access token for this resource.
  fetch: (request, env) => handleMcp(request, env),
};

// The resource URL must be absolute, and a workers.dev hostname is only known once deployed,
// so the provider is built on the first request (from PUBLIC_URL, else the request origin).
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/oauth/token',
      clientRegistrationEndpoint: '/oauth/register', // Dynamic Client Registration
      clientIdMetadataDocumentEnabled: true, // Client ID Metadata Documents (MCP 2026 default)
      scopesSupported: [SCOPE, 'offline_access'],
      requiredScopes: [SCOPE],
      resourceMetadata: { resource: `${origin}/mcp`, resource_name: 'Garmin (read-only)' },
      accessTokenTTL: 60 * 60,
      // Stay connected while in use; a grant idle for 30 days needs a fresh sign-in.
      refreshTokenTTL: 30 * 24 * 60 * 60,
      refreshTokenIdleTTL: 30 * 24 * 60 * 60,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    const origin = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, '').toLowerCase();
    return providerFor(origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
