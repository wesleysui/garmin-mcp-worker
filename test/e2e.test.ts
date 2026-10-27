/**
 * End-to-end test with Bun: the real OAuth library and MCP handler, an in-memory KV, and a fake
 * Garmin API. Walks the path claude.ai takes: discovery → client registration → consent page →
 * password → token → MCP calls in both protocol eras.   Run: bun test
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';

mock.module('cloudflare:workers', () => ({ WorkerEntrypoint: class {} }));

const ORIGIN = 'https://garmin-mcp.example.workers.dev';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PASSWORD = 'correct horse battery staple';

// ---------------------------------------------------------------- in-memory KV
class MemoryKV {
  store = new Map<string, { value: string; metadata?: unknown }>();
  async get(key: string, type?: string | { type?: string }) {
    const entry = this.store.get(key);
    if (!entry) return null;
    const kind = typeof type === 'string' ? type : type?.type;
    return kind === 'json' ? JSON.parse(entry.value) : entry.value;
  }
  async getWithMetadata(key: string, type?: string | { type?: string }) {
    const value = await this.get(key, type);
    return { value, metadata: this.store.get(key)?.metadata ?? null };
  }
  async put(key: string, value: string, options?: { metadata?: unknown }) {
    this.store.set(key, { value: String(value), metadata: options?.metadata });
  }
  async delete(key: string) {
    this.store.delete(key);
  }
  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}) {
    const keys = [...this.store.keys()]
      .filter((k) => k.startsWith(options.prefix ?? ''))
      .map((name) => ({ name, metadata: this.store.get(name)?.metadata }));
    return { keys, list_complete: true, cursor: '' };
  }
}

// ---------------------------------------------------------------- fake Garmin
const garminCalls: string[] = [];
const jwt = (exp: number) =>
  `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.hostname !== 'personal.connectapi.garmin.com') return realFetch(input as RequestInfo, init);
  garminCalls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
  const auth = new Headers(init?.headers).get('Authorization') ?? '';
  if (url.pathname.endsWith('/personal-api-key/token')) {
    return auth === 'ApiKey test-key'
      ? new Response(jwt(Math.floor(Date.now() / 1000) + 86400))
      : new Response('bad key', { status: 401 });
  }
  if (!auth.startsWith('Bearer ')) return new Response('unauthorized', { status: 401 });
  const body = (data: unknown) => Response.json(data);
  if (url.pathname === '/usersummary-service/v2/dailysummaries') {
    return body({
      data: [
        { calendarDate: '2026-10-26', restingHeartRate: 48, bodyBatteryHighestValue: 92, bodyBatteryAtWakeTime: 88, averageStressLevel: 21, vigorousIntensityMinutes: 40 },
        // Real v2 shape: nested objects.
        {
          calendarDate: '2026-10-27',
          heartRate: { restingValue: 51 },
          bodyBattery: { maxValue: 70, minValue: 31, activityEvents: [{ eventType: 'SLEEP', bodyBatteryImpact: 34 }] },
          stress: { avgLevel: 30 },
          movement: { steps: { value: 964 } },
        },
      ],
    });
  }
  if (url.pathname === '/sleep-service/sleep/dailySleepSummariesByDate') {
    return body([{ calendarDate: '2026-10-27', sleepTimeSeconds: 25200, deepSleepSeconds: 5400, sleepScores: { overall: { value: 81, qualifierKey: 'GOOD' } } }]);
  }
  if (url.pathname.startsWith('/hrv-service/hrv/daily/')) {
    return body({ hrvSummaries: [{ calendarDate: '2026-10-27', lastNightAvg: 62, weeklyAvg: 66, status: 'BALANCED', baseline: { balancedLow: 58, balancedUpper: 74, lowUpper: 54 } }] });
  }
  if (url.pathname === '/activitylist-service/activities/search/activities') {
    return body([
      { activityId: 2, activityName: 'Intervals', activityType: { typeKey: 'running' }, startTimeLocal: '2026-10-25 06:00:00', distance: 10000, duration: 2700, averageSpeed: 3.7037, averageHR: 155, vO2MaxValue: 55 },
      { activityId: 1, activityName: 'Easy run', activityType: { typeKey: 'running' }, startTimeLocal: '2026-09-01 06:00:00', distance: 8000, duration: 2880, averageSpeed: 2.7778, vO2MaxValue: 53 },
    ]);
  }
  if (url.pathname === '/wellness-service/wellness/dailyHeartRate') {
    return body({ restingHeartRate: 50, heartRateValues: Array.from({ length: 720 }, (_, i) => [i, 60]) });
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

// ---------------------------------------------------------------- harness
const env = {
  OAUTH_KV: new MemoryKV() as unknown as KVNamespace,
  GARMIN_API_KEY: 'test-key',
  LOGIN_PASSWORD: PASSWORD,
  PUBLIC_URL: ORIGIN,
  TIMEZONE: 'Africa/Johannesburg',
};
const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
let worker: { fetch: (r: Request, e: typeof env, c: ExecutionContext) => Promise<Response> };
const call = (path: string, init?: RequestInit) => worker.fetch(new Request(ORIGIN + path, init), env, ctx);

const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

let accessToken = '';
let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown> = {}, modern = true) {
  const version = modern ? '2026-07-28' : '2025-06-18';
  const payload = {
    jsonrpc: '2.0',
    id: ++rpcId,
    method,
    params: modern ? { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version } } : params,
  };
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${accessToken}`,
    'MCP-Protocol-Version': version,
    'Mcp-Method': method,
  };
  if (method === 'tools/call') headers['Mcp-Name'] = String(params.name);
  const res = await call('/mcp', { method: 'POST', headers, body: JSON.stringify(payload) });
  return { status: res.status, body: (await res.json()) as any };
}

beforeAll(async () => {
  worker = (await import('../src/index')).default as unknown as typeof worker;
});

describe('OAuth sign-in', () => {
  test('unauthenticated MCP request gets a Bearer challenge pointing at resource metadata', async () => {
    const res = await call('/mcp', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('WWW-Authenticate')).toContain('resource_metadata=');
    const meta = (await (await call('/.well-known/oauth-protected-resource/mcp')).json()) as any;
    expect(meta.resource).toBe(`${ORIGIN}/mcp`);
    expect(meta.scopes_supported).toContain('garmin:read');
  });

  test('register → consent → password → token', async () => {
    const reg = (await (
      await call('/oauth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', application_type: 'web' }),
      })
    ).json()) as any;
    expect(reg.client_id).toBeTruthy();

    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: reg.client_id,
      redirect_uri: REDIRECT,
      scope: 'garmin:read offline_access',
      state: 'xyz',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: `${ORIGIN}/mcp`,
    });
    const consent = await call(`/authorize?${query}`);
    expect(consent.status).toBe(200);
    const html = await consent.text();
    expect(html).toContain('Claude');
    expect(html).toContain('claude.ai');
    const handle = /name="handle" value="([^"]+)"/.exec(html)![1];
    const cookie = consent.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    const post = (password: string) =>
      call('/authorize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie },
        body: new URLSearchParams({ handle, decision: 'approve', password, client_name: 'Claude', redirect_host: 'claude.ai' }),
        redirect: 'manual',
      });

    expect((await post('wrong')).status).toBe(401);
    const ok = await post(PASSWORD);
    expect(ok.status).toBe(302);
    const location = new URL(ok.headers.get('Location')!);
    expect(location.origin + location.pathname).toBe(REDIRECT);
    expect(location.searchParams.get('state')).toBe('xyz');

    const token = (await (
      await call('/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: location.searchParams.get('code')!,
          redirect_uri: REDIRECT,
          client_id: reg.client_id,
          code_verifier: verifier,
          resource: `${ORIGIN}/mcp`,
        }),
      })
    ).json()) as any;
    expect(token.access_token).toBeTruthy();
    expect(token.refresh_token).toBeTruthy();
    accessToken = token.access_token;
  });
});

describe('MCP', () => {
  test('modern era: server/discover', async () => {
    const { status, body } = await rpc('server/discover');
    expect(status).toBe(200);
    expect(body.result.resultType).toBe('complete');
    expect(body.result.supportedVersions).toContain('2026-07-28');
    expect(body.result._meta['io.modelcontextprotocol/serverInfo'].name).toBeTruthy();
  });

  test('legacy era: initialize handshake', async () => {
    const { body } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, false);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities.tools).toBeTruthy();
  });

  test('unsupported version and header mismatch are rejected', async () => {
    const res = await call('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, 'MCP-Protocol-Version': '2026-07-28' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-06-18' } } }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error.code).toBe(-32020);
  });

  test('tools/list returns read-only tools with cache hints', async () => {
    const { body } = await rpc('tools/list');
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toContain('garmin_get_recovery_trend');
    expect(body.result.tools.every((t: any) => t.annotations.readOnlyHint)).toBe(true);
    expect(body.result.ttlMs).toBeGreaterThan(0);
  });

  test('recovery trend merges HRV, sleep and daily summary per morning', async () => {
    const { body } = await rpc('tools/call', { name: 'garmin_get_recovery_trend', arguments: { start_date: '2026-10-26', end_date: '2026-10-27' } });
    expect(body.result.isError).toBeUndefined();
    const data = JSON.parse(body.result.content[0].text);
    const day = data.days.find((d: any) => d.date === '2026-10-27');
    expect(day.hrv.last_night_avg_ms).toBe(62);
    expect(day.hrv.baseline_balanced_ms).toEqual([58, 74]);
    expect(day.sleep.hours).toBe(7);
    expect(day.sleep.score).toBe(81);
    expect(day.resting_hr).toBe(51);
    expect(day.body_battery.high).toBe(70);
    expect(day.body_battery.overnight_charge).toBe(34);
    expect(day.steps).toBe(964);
    const flat = data.days.find((d: any) => d.date === '2026-10-26');
    expect(flat.resting_hr).toBe(48);
  });

  test('activities become compact rows with pace and rounded training effect', async () => {
    const list = JSON.parse((await rpc('tools/call', { name: 'garmin_search_activities', arguments: { limit: 5 } })).body.result.content[0].text);
    expect(list.activities[0].avg_pace).toBe('4:30/km');
    expect(list.activities[0].distance_km).toBe(10);
    expect(list.activities[1].avg_pace).toBe('6:00/km');
  });

  test('long sample arrays are summarised unless requested', async () => {
    const hr = JSON.parse((await rpc('tools/call', { name: 'garmin_get_heart_rate', arguments: { date: '2026-10-27' } })).body.result.content[0].text);
    expect(hr.heartRateValues.omitted_samples).toBe(720);
  });

  test('bad arguments come back as a tool error the model can read', async () => {
    const { body } = await rpc('tools/call', { name: 'garmin_get_hrv_summaries', arguments: { days: 400 } });
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('at most 365');
  });

  test('raw reader refuses the token endpoint', async () => {
    const { body } = await rpc('tools/call', { name: 'garmin_api_get', arguments: { path: '/personalapitoken-service/x' } });
    expect(body.result.isError).toBe(true);
  });

  test('Garmin token is exchanged once and reused', () => {
    expect(garminCalls.filter((c) => c.includes('/personal-api-key/token')).length).toBe(1);
  });
});
