/** Bindings and secrets this Worker needs (see wrangler.jsonc and README). */
export interface Env {
  /** KV namespace for OAuth grants/tokens and the cached Garmin bearer token. */
  OAUTH_KV: KVNamespace;
  /** Garmin Connect Personal API key (secret). */
  GARMIN_API_KEY: string;
  /** Password you type on the authorization page when connecting Claude (secret). */
  LOGIN_PASSWORD: string;
  /** Optional: canonical https origin, e.g. https://garmin-mcp.you.workers.dev. Defaults to the request origin. */
  PUBLIC_URL?: string;
  /** IANA time zone used for "today" and default date ranges. Defaults to UTC. */
  TIMEZONE?: string;
}
