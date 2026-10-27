/**
 * Minimal client for the official Garmin Connect Personal API.
 *
 * Mirrors Garmin's own Python client (github.com/garmin/connect-personal-api-python):
 * the API key is exchanged for a short-lived JWT bearer token, which is cached and
 * renewed one hour before it expires; a 401 gets exactly one retry with a fresh token.
 */
import { windows } from './dates';
import type { Env } from './env';

const BASE_URL = 'https://personal.connectapi.garmin.com';
const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';
const REFRESH_WINDOW_S = 60 * 60;
const TIMEOUT_MS = 30_000;
const ERROR_DETAIL_MAX = 200;

export class GarminError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryAfterSeconds?: number
  ) {
    super(message);
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;
interface CachedToken {
  token: string;
  exp: number;
  fingerprint: string;
}

// Survives between requests on the same isolate; KV covers cold starts.
let memoryToken: CachedToken | undefined;

export class GarminClient {
  constructor(private readonly env: Env) {}

  /** GET a JSON endpoint. Returns null when Garmin has no data (204, or 404 for a day not synced yet). */
  async get(path: string, params?: Params): Promise<unknown> {
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    let response = await this.send(url, await this.bearer(false));
    if (response.status === 401) response = await this.send(url, await this.bearer(true));

    if (response.status === 204 || response.status === 404) return null;
    if (response.status === 429) {
      const retry = Number(response.headers.get('Retry-After'));
      throw new GarminError(
        'Garmin rate limit reached (HTTP 429). Try again later.',
        429,
        Number.isFinite(retry) ? retry : undefined
      );
    }
    if (response.status === 401 || response.status === 403) {
      throw new GarminError(
        'Garmin rejected the Personal API key. It may have expired: create a new one in Garmin Connect and update the GARMIN_API_KEY secret.',
        response.status
      );
    }
    if (!response.ok) {
      throw new GarminError(`Garmin answered HTTP ${response.status}: ${await safeDetail(response)}`, response.status);
    }
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new GarminError('Garmin returned a response that is not JSON');
    }
  }

  /** Fetch a long range in windows the endpoint accepts and concatenate the rows. */
  async ranged(
    start: string,
    end: string,
    maxDays: number,
    fetchWindow: (first: string, last: string) => Promise<unknown>
  ): Promise<unknown[]> {
    const rows: unknown[] = [];
    for (const [first, last] of windows(start, end, maxDays)) {
      const page = await fetchWindow(first, last);
      if (Array.isArray(page)) rows.push(...page);
      else if (page !== null && page !== undefined) rows.push(page);
    }
    return rows;
  }

  private async send(url: URL, token: string): Promise<Response> {
    try {
      return await fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new GarminError(`Could not reach Garmin: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async bearer(forceRefresh: boolean): Promise<string> {
    const key = this.env.GARMIN_API_KEY?.trim();
    if (!key) throw new GarminError('GARMIN_API_KEY is not set. Run: npx wrangler secret put GARMIN_API_KEY');
    // Tokens are only reused for the same key, so rotating the secret takes effect at once.
    const fingerprint = await sha256Hex(`${BASE_URL}\0${key}`);
    const now = Date.now() / 1000;
    const fresh = (t?: CachedToken | null): t is CachedToken =>
      !!t && t.fingerprint === fingerprint && t.exp - now > REFRESH_WINDOW_S;

    if (!forceRefresh) {
      if (fresh(memoryToken)) return memoryToken.token;
      const stored = await this.env.OAUTH_KV.get<CachedToken>('garmin-cache:bearer', 'json');
      if (fresh(stored)) {
        memoryToken = stored;
        return stored.token;
      }
    }

    let response: Response;
    try {
      response = await fetch(new URL(TOKEN_PATH, BASE_URL), {
        method: 'POST',
        headers: { Accept: '*/*', Authorization: `ApiKey ${key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new GarminError(`Could not reach Garmin: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status === 401 || response.status === 403) {
      throw new GarminError(
        'Garmin rejected the Personal API key. It may have expired or been deleted: create a new one in Garmin Connect and update the GARMIN_API_KEY secret.',
        response.status
      );
    }
    if (!response.ok) {
      throw new GarminError(`Garmin token exchange failed (HTTP ${response.status})`, response.status);
    }
    const token = (await response.text()).trim();
    const exp = jwtExpiry(token);
    const cached: CachedToken = { token, exp, fingerprint };
    memoryToken = cached;
    const ttl = Math.floor(exp - now - 60);
    if (ttl >= 60) await this.env.OAUTH_KV.put('garmin-cache:bearer', JSON.stringify(cached), { expirationTtl: ttl });
    return token;
  }
}

function jwtExpiry(token: string): number {
  try {
    const payload = token.split('.')[1];
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const json = JSON.parse(atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4)));
    const exp = Number(json.exp);
    if (!Number.isFinite(exp)) throw new Error('no exp');
    return exp;
  } catch {
    throw new GarminError('Garmin token endpoint did not return a JWT with an exp claim');
  }
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** A short, secret-free excerpt of an error body for the model to read. */
async function safeDetail(response: Response): Promise<string> {
  const text = (await response.text().catch(() => '')).replace(/\s+/g, ' ').trim();
  const redacted = text.replace(/(bearer|apikey|token|authorization)[^,;}]*/gi, '$1 [redacted]');
  return redacted.slice(0, ERROR_DETAIL_MAX) || response.statusText || 'no detail';
}
