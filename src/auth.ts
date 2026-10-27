/**
 * The /authorize page: a single-owner sign-in (a password stored as a Worker secret) plus the
 * consent screen the MCP spec requires (client name, where tokens go, scopes). The OAuth
 * library validates the request, keeps it server-side between GET and POST, and issues tokens.
 */
import { AuthorizationError, type OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Env } from './env';

export const SCOPE = 'garmin:read';
const OWNER = 'owner';
const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 15 * 60;
const FAILURES_KEY = 'garmin-cache:login-failures';

type EnvWithHelpers = Env & { OAUTH_PROVIDER: OAuthHelpers };

const escape = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

export const defaultHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/authorize') {
      try {
        return request.method === 'POST'
          ? await approve(request, env as EnvWithHelpers)
          : await showConsent(request, env as EnvWithHelpers);
      } catch (error) {
        if (error instanceof AuthorizationError) {
          if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
          return page('Cannot continue', `<p>${escape(error.description ?? 'Invalid request')}</p><p>Start connecting again from Claude.</p>`, 400);
        }
        throw error;
      }
    }
    if (url.pathname === '/') {
      return page(
        'Garmin MCP',
        `<p>This is a private MCP server for one person's Garmin data.</p><p>Add <code>${escape(url.origin)}/mcp</code> as a custom connector in Claude.</p>`
      );
    }
    return new Response('Not found', { status: 404 });
  },
};

async function showConsent(request: Request, env: EnvWithHelpers): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  const body = form({
    handle: consent.handle,
    clientName: details.clientName,
    clientDomain: details.clientDomain,
    redirectHost: details.redirectHost,
    loopback: details.redirectIsLoopback,
  });
  consent.headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { headers: consent.headers });
}

async function approve(request: Request, env: EnvWithHelpers): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const data = await request.formData();
  const handle = String(data.get('handle') ?? '');
  const shown = {
    handle,
    clientName: String(data.get('client_name') ?? 'this app'),
    clientDomain: String(data.get('client_domain') ?? '') || undefined,
    redirectHost: String(data.get('redirect_host') ?? ''),
    loopback: data.get('loopback') === '1',
  };

  if (data.get('decision') !== 'approve') {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }

  // Check the password before approveConsent(), which consumes the one-time handle.
  const failures = Number((await env.OAUTH_KV.get(FAILURES_KEY)) ?? 0);
  if (failures >= MAX_FAILURES) {
    return page('Too many attempts', '<p>Too many wrong passwords. Wait 15 minutes and connect again from Claude.</p>', 429);
  }
  if (!env.LOGIN_PASSWORD) {
    return page('Not configured', '<p>LOGIN_PASSWORD is not set. Run <code>npx wrangler secret put LOGIN_PASSWORD</code>.</p>', 500);
  }
  if (!(await passwordMatches(String(data.get('password') ?? ''), env.LOGIN_PASSWORD))) {
    await env.OAUTH_KV.put(FAILURES_KEY, String(failures + 1), { expirationTtl: LOCKOUT_SECONDS });
    return new Response(form({ ...shown, error: 'Wrong password.' }), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
    });
  }
  await env.OAUTH_KV.delete(FAILURES_KEY);

  const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request, // from storage, not from the form
    userId: OWNER,
    metadata: { clientName: shown.clientName },
    scope: approved.request.scope,
    props: { user: OWNER },
  });
  approved.headers.set('Location', redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

/** Constant-time comparison of SHA-256 digests, so timing reveals nothing about the password. */
async function passwordMatches(given: string, expected: string): Promise<boolean> {
  const digest = async (value: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  const [a, b] = await Promise.all([digest(given), digest(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function form(view: {
  handle: string;
  clientName: string;
  clientDomain?: string;
  redirectHost: string;
  loopback: boolean;
  error?: string;
}): string {
  const name = escape(view.clientName);
  const origin = view.clientDomain
    ? `Published by <strong>${escape(view.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  const loopbackWarning = view.loopback
    ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>'
    : '';
  const error = view.error ? `<p class="error">${escape(view.error)}</p>` : '';
  return shell(
    `Allow ${name}?`,
    `<h1>Allow <span>${name}</span> to read your Garmin data?</h1>
<p>${origin} Access will be sent to <strong>${escape(view.redirectHost)}</strong>.</p>
${loopbackWarning}
<ul><li>Read-only: sleep, HRV, Body Battery, stress, heart rate, activities and profile.</li><li>Scope: <code>${SCOPE}</code></li></ul>
${error}
<form method="post" autocomplete="off">
  <input type="hidden" name="handle" value="${escape(view.handle)}">
  <input type="hidden" name="client_name" value="${escape(view.clientName)}">
  <input type="hidden" name="client_domain" value="${escape(view.clientDomain ?? '')}">
  <input type="hidden" name="redirect_host" value="${escape(view.redirectHost)}">
  <input type="hidden" name="loopback" value="${view.loopback ? '1' : '0'}">
  <label for="password">Owner password</label>
  <input id="password" name="password" type="password" autofocus>
  <div class="actions">
    <button name="decision" value="approve" class="primary">Allow</button>
    <button name="decision" value="deny" formnovalidate>Deny</button>
  </div>
</form>`
  );
}

function page(title: string, content: string, status = 200): Response {
  return new Response(shell(escape(title), `<h1>${escape(title)}</h1>${content}`), {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'" },
  });
}

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#5b6170; --accent:#0a7cff; --border:#dfe2e8; --danger:#c62828; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1115; --card:#181b21; --text:#eceef2; --muted:#9aa1ad; --border:#2a2f38; --danger:#ef7a7a; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:16px; background:var(--bg); color:var(--text); font:16px/1.5 system-ui, -apple-system, Segoe UI, sans-serif; }
  main { width:100%; max-width:440px; background:var(--card); border:1px solid var(--border); border-radius:14px; padding:24px; }
  h1 { font-size:1.25rem; margin:0 0 12px; } h1 span { color:var(--accent); }
  p, li { color:var(--muted); } ul { padding-left:20px; } code { font-size:.9em; }
  label { display:block; font-weight:600; margin:16px 0 6px; }
  input[type=password] { width:100%; padding:12px; border-radius:10px; border:1px solid var(--border); background:transparent; color:inherit; font-size:16px; }
  .actions { display:flex; gap:10px; margin-top:16px; }
  button { flex:1; padding:12px; border-radius:10px; border:1px solid var(--border); background:transparent; color:inherit; font-size:16px; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600; }
  .error, .warn { color:var(--danger); font-weight:600; }
</style></head><body><main>${body}</main></body></html>`;
}
