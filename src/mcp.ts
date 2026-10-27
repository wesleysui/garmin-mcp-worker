/**
 * Stateless MCP over Streamable HTTP (JSON responses), speaking both protocol eras:
 * - 2026-07-28: no handshake; every request carries its version in `_meta`, `server/discover`,
 *   `resultType` on results, `ttlMs`/`cacheScope` on list results, header validation;
 * - 2025-03-26 … 2025-11-25: `initialize` handshake, `ping`, no sessions needed here.
 * Everything is read-only and needs no server-initiated messages, so no SSE stream is used.
 */
import { InputError } from './dates';
import type { Env } from './env';
import { GarminClient, GarminError } from './garmin';
import { TOOLS, type ToolContext } from './tools';

const MODERN = '2026-07-28';
const LEGACY = ['2025-11-25', '2025-06-18', '2025-03-26'];
const SUPPORTED = [MODERN, ...LEGACY];
const SERVER_INFO = { name: 'garmin-personal-mcp-worker', version: '1.1.0' };
const META = {
  version: 'io.modelcontextprotocol/protocolVersion',
  serverInfo: 'io.modelcontextprotocol/serverInfo',
} as const;
const INSTRUCTIONS =
  'Read-only access to the user\'s own Garmin Connect data through Garmin\'s official Personal API. ' +
  'For recovery or "should I train hard today" questions, start with garmin_get_recovery_trend. ' +
  'Sleep and HRV are filed under the morning the user woke up. Garmin\'s Training Readiness, Training Status and daily VO2max are not in this API; ' +
  'Garmin currently strips VO2max from API data, so ask the user for the value shown on their watch if needed. Units: distances in km in compact rows, raw endpoints use meters/seconds as Garmin sends them.';
const LIST_TTL_MS = 60 * 60 * 1000;

const ERR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  unsupportedVersion: -32022,
} as const;

interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}
type RpcResponse = Record<string, unknown>;
class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly httpStatus = 200,
    readonly data?: unknown
  ) {
    super(message);
  }
}

const TOOL_LIST = TOOLS.map((tool) => ({
  name: tool.name,
  title: tool.title,
  description: tool.description,
  inputSchema: tool.inputSchema,
  annotations: { title: tool.title, readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
}));

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    // No standalone SSE stream and no sessions to delete.
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: ERR.parse, message: 'Parse error' } }, 400);
  }

  // JSON-RPC batches were allowed in 2025-03-26 only; answering them costs nothing.
  const messages = Array.isArray(body) ? (body as RpcMessage[]) : [body as RpcMessage];
  const ctx: ToolContext = { garmin: new GarminClient(env), timeZone: env.TIMEZONE };
  const responses: RpcResponse[] = [];
  let status = 200;
  for (const message of messages) {
    const { response, httpStatus } = await handleMessage(message, request, ctx, messages.length === 1);
    if (response) responses.push(response);
    if (messages.length === 1) status = httpStatus;
  }
  if (!responses.length) return new Response(null, { status: 202 });
  return json(Array.isArray(body) ? responses : responses[0], status);
}

async function handleMessage(
  message: RpcMessage,
  request: Request,
  ctx: ToolContext,
  single: boolean
): Promise<{ response?: RpcResponse; httpStatus: number }> {
  const isNotification = message?.id === undefined;
  if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    if (isNotification && message?.method) return { httpStatus: 202 };
    return { response: error(message?.id ?? null, ERR.invalidRequest, 'Invalid Request'), httpStatus: 400 };
  }
  if (isNotification) return { httpStatus: 202 }; // notifications/initialized, cancellations, …

  const id = message.id ?? null;
  try {
    const { version, modern } = negotiate(message, request);
    const result = await dispatch(message, request, ctx, version, modern);
    const decorated = modern
      ? { resultType: 'complete', ...result, _meta: { ...(result._meta as object), [META.serverInfo]: SERVER_INFO } }
      : result;
    return { response: { jsonrpc: '2.0', id, result: decorated }, httpStatus: 200 };
  } catch (err) {
    if (err instanceof RpcError) {
      return { response: error(id, err.code, err.message, err.data), httpStatus: single ? err.httpStatus : 200 };
    }
    console.error('MCP handler failure', err);
    return { response: error(id, ERR.internal, 'Internal error'), httpStatus: 500 };
  }
}

/** Work out which protocol era a request belongs to and validate its version headers. */
function negotiate(message: RpcMessage, request: Request): { version: string; modern: boolean } {
  const header = request.headers.get('mcp-protocol-version') ?? undefined;
  const meta = (message.params?._meta as Record<string, unknown> | undefined)?.[META.version];

  if (typeof meta === 'string') {
    if (header && header !== meta) {
      throw new RpcError(ERR.headerMismatch, `Header mismatch: MCP-Protocol-Version '${header}' does not match body '${meta}'`, 400);
    }
    if (meta !== MODERN) {
      throw new RpcError(ERR.unsupportedVersion, 'Unsupported protocol version', 400, { supported: SUPPORTED, requested: meta });
    }
    const methodHeader = request.headers.get('mcp-method');
    if (methodHeader && methodHeader !== message.method) {
      throw new RpcError(ERR.headerMismatch, `Header mismatch: Mcp-Method '${methodHeader}' does not match body '${message.method}'`, 400);
    }
    const nameHeader = request.headers.get('mcp-name');
    const bodyName = message.params?.name;
    if (nameHeader && message.method === 'tools/call' && decodeHeader(nameHeader) !== bodyName) {
      throw new RpcError(ERR.headerMismatch, 'Header mismatch: Mcp-Name does not match params.name', 400);
    }
    return { version: MODERN, modern: true };
  }

  if (message.method === 'initialize') {
    const requested = message.params?.protocolVersion;
    const version = typeof requested === 'string' && LEGACY.includes(requested) ? requested : LEGACY[0];
    return { version, modern: false };
  }
  if (header && !SUPPORTED.includes(header)) {
    throw new RpcError(ERR.unsupportedVersion, 'Unsupported protocol version', 400, { supported: SUPPORTED, requested: header });
  }
  // A request without per-request metadata is a legacy client after its initialize call.
  return { version: header ?? '2025-03-26', modern: false };
}

async function dispatch(
  message: RpcMessage,
  request: Request,
  ctx: ToolContext,
  version: string,
  modern: boolean
): Promise<Record<string, unknown>> {
  const capabilities = { tools: { listChanged: false } };
  switch (message.method) {
    case 'server/discover':
      return {
        supportedVersions: SUPPORTED,
        capabilities,
        instructions: INSTRUCTIONS,
        _meta: { [META.serverInfo]: SERVER_INFO },
        ttlMs: LIST_TTL_MS,
        cacheScope: 'private',
      };
    case 'initialize':
      if (modern) break; // removed in 2026-07-28
      return { protocolVersion: version, capabilities, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS };
    case 'ping':
      if (modern) break; // removed in 2026-07-28
      return {};
    case 'tools/list':
      return modern ? { tools: TOOL_LIST, ttlMs: LIST_TTL_MS, cacheScope: 'private' } : { tools: TOOL_LIST };
    case 'tools/call':
      return callTool(message.params ?? {}, ctx);
    case 'resources/list':
      return modern ? { resources: [], ttlMs: LIST_TTL_MS, cacheScope: 'private' } : { resources: [] };
    case 'prompts/list':
      return modern ? { prompts: [], ttlMs: LIST_TTL_MS, cacheScope: 'private' } : { prompts: [] };
  }
  throw new RpcError(ERR.methodNotFound, `Method not found: ${message.method}`, modern ? 404 : 200);
}

async function callTool(params: Record<string, unknown>, ctx: ToolContext): Promise<Record<string, unknown>> {
  const tool = TOOLS.find((t) => t.name === params.name);
  if (!tool) throw new RpcError(ERR.invalidParams, `Unknown tool: ${String(params.name)}`);
  const args = params.arguments && typeof params.arguments === 'object' ? (params.arguments as Record<string, unknown>) : {};
  try {
    const result = await tool.run(args, ctx);
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (err) {
    // Tool failures go back to the model as results it can read and react to.
    const text =
      err instanceof InputError
        ? `Invalid arguments: ${err.message}`
        : err instanceof GarminError
          ? err.message + (err.retryAfterSeconds ? ` (retry after ${err.retryAfterSeconds}s)` : '')
          : `Unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    if (!(err instanceof InputError) && !(err instanceof GarminError)) console.error('Tool failure', tool.name, err);
    return { content: [{ type: 'text', text }], isError: true };
  }
}

/** Mcp-Name may use the Base64 sentinel form: =?base64?…?= */
function decodeHeader(value: string): string {
  const match = /^=\?base64\?(.*)\?=$/i.exec(value);
  if (!match) return value;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0)));
  } catch {
    return value;
  }
}

function error(id: unknown, code: number, message: string, data?: unknown): RpcResponse {
  return { jsonrpc: '2.0', id, error: data === undefined ? { code, message } : { code, message, data } };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}
