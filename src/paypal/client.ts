// Thin PayPal REST client: OAuth client-credentials with a cached token, timeouts, readable errors.
// Sandbox only: any other host is refused.

const SANDBOX_HOST = "api-m.sandbox.paypal.com";
const TIMEOUT_MS = 15_000;

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly debugId?: string,
    readonly details?: unknown,
    /** PayPal's error name, e.g. UNPROCESSABLE_ENTITY or INVALID_RESOURCE_ID. */
    readonly paypalName?: string,
  ) {
    super(message);
    this.name = "PayPalError";
  }
}

/** PAYPAL_MODE: "sandbox" (default) or "mock" (src/paypal/mock.ts). Mock mode refuses to run in production unless
 * ALLOW_MOCK_IN_PROD=true (a deploy check; the mock banner always shows). */
export function paypalMode(): "sandbox" | "mock" {
  const mode = process.env.PAYPAL_MODE || "sandbox";
  if (mode !== "sandbox" && mode !== "mock") throw new PayPalError(`PAYPAL_MODE must be "sandbox" or "mock", not "${mode}"`, 0);
  if (mode === "mock" && process.env.NODE_ENV === "production" && process.env.ALLOW_MOCK_IN_PROD !== "true") {
    throw new PayPalError("PAYPAL_MODE=mock is for local development only and is refused in production. Set PAYPAL_MODE=sandbox (or ALLOW_MOCK_IN_PROD=true for a deploy check).", 0);
  }
  return mode;
}

export const isMockMode = () => paypalMode() === "mock";

/** Validated sandbox config. Also used before handing credentials to the Agent Toolkit. */
export function config() {
  if (isMockMode()) return { base: "mock", id: "mock", secret: "mock" };
  const base = process.env.PAYPAL_BASE_URL || `https://${SANDBOX_HOST}`;
  if (new URL(base).hostname !== SANDBOX_HOST) {
    throw new PayPalError(`PAYPAL_BASE_URL must be https://${SANDBOX_HOST}; ClearDue never talks to live PayPal`, 0);
  }
  const id = process.env.PAYPAL_CLIENT_ID;
  const secret = process.env.PAYPAL_CLIENT_SECRET;
  if (!id || !secret) {
    throw new PayPalError("PayPal is not configured: set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET", 0);
  }
  return { base: base.replace(/\/$/, ""), id, secret };
}

let cachedToken: { token: string; expiresAt: number } | null = null;

export function resetTokenCache() {
  cachedToken = null;
}

async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new PayPalError(`PayPal did not respond within ${TIMEOUT_MS / 1000}s`, 504);
    }
    throw new PayPalError(`Could not reach PayPal: ${e instanceof Error ? e.message : String(e)}`, 502);
  }
}

interface PayPalErrorBody {
  name?: string;
  message?: string;
  error_description?: string;
  debug_id?: string;
  details?: { issue?: string; description?: string; field?: string }[];
}

async function toError(res: Response): Promise<PayPalError> {
  const body = (await res.json().catch(() => ({}))) as PayPalErrorBody;
  const details = (body.details ?? [])
    .map((d) => [d.field, d.issue, d.description].filter(Boolean).join(": "))
    .join("; ");
  const head = body.message || body.error_description || body.name || res.statusText || "request failed";
  return new PayPalError(`PayPal ${res.status}: ${head}${details ? ` (${details})` : ""}`, res.status, body.debug_id, body.details, body.name);
}

/** One log line per PayPal failure: status, error name, issues and debug_id (what PayPal support asks for). Never the
 * token, never a request or response body (they carry names and email addresses). */
export function logPayPalError(where: string, err: PayPalError) {
  const issues = Array.isArray(err.details) ? (err.details as { issue?: string }[]).map((d) => d.issue).filter(Boolean).join(",") : "";
  console.error(`[paypal] ${where} failed: status=${err.status} name=${err.paypalName ?? "-"}${issues ? ` issues=${issues}` : ""} debug_id=${err.debugId ?? "-"}`);
}

const ISSUE_TEXT: Record<string, string> = {
  INVALID_INVOICE_STATUS: "PayPal says this invoice can't be changed in its current state. It may have been paid, cancelled or refunded in PayPal; press Sync to see the latest.",
  CANNOT_UPDATE_INVOICE: "PayPal says this invoice can't be changed in its current state. It may have been paid, cancelled or refunded in PayPal; press Sync to see the latest.",
  // Recorded from the sandbox (debug_id f34268289bfd1): reminding an invoice that is a draft, paid or cancelled.
  CANNOT_REMIND_INVOICE: "PayPal only sends reminders for invoices that have been sent and are still unpaid. Press Sync to see the invoice's current state.",
  CANNOT_CANCEL_INVOICE: "PayPal can't cancel this invoice in its current state. It may already be paid or cancelled; press Sync to see the latest.",
  PARTIAL_PAYMENT_NOT_ALLOWED: "PayPal doesn't allow part payments for accounts in your country, so this plan has to use separate invoices.",
  INVALID_RESOURCE_ID: "PayPal can't find this invoice any more. It may have been deleted in PayPal.",
  DUPLICATE_INVOICE_NUMBER: "PayPal already has an invoice with this number.",
};

/** A sentence a freelancer can act on, for any error. The technical detail stays in the logs and the timeline data. */
export function plainPayPalMessage(e: unknown): string {
  if (!(e instanceof PayPalError)) return e instanceof Error ? e.message : String(e);
  const issues = Array.isArray(e.details) ? (e.details as { issue?: string }[]).map((d) => d.issue ?? "") : [];
  const known = issues.map((i) => ISSUE_TEXT[i]).find(Boolean);
  const ref = e.debugId ? ` (PayPal reference ${e.debugId})` : "";
  if (known) return known + ref;
  if (e.status === 0) return e.message; // our own configuration message
  if (e.status === 401 || e.status === 403) return `PayPal refused ClearDue's credentials. Check the app's client ID and secret in the PayPal developer dashboard.${ref}`;
  if (e.status === 404) return `PayPal can't find this invoice. It may have been deleted in PayPal.${ref}`;
  if (e.status === 422 || e.status === 400) return `PayPal rejected the change: ${e.message.replace(/^PayPal \d+: /, "")}${ref}`;
  if (e.status === 429) return `PayPal is rate-limiting requests. Try again in a minute.${ref}`;
  if (e.status >= 500) return `PayPal is having trouble right now (${e.status}). Nothing was changed; try again shortly.${ref}`;
  return e.message + ref;
}

export async function getAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.token;
  return fetchAccessToken();
}

async function fetchAccessToken(): Promise<string> {
  const { base, id, secret } = config();
  const res = await timedFetch(`${base}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) {
    const err = await toError(res);
    logPayPalError("POST /v1/oauth2/token", err);
    throw err;
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  // Refresh a minute early so a token never expires mid-request.
  cachedToken = { token: json.access_token, expiresAt: Date.now() + (json.expires_in - 60) * 1000 };
  return json.access_token;
}

export interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  headers?: Record<string, string>;
}

export async function paypalRequest<T>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  if (isMockMode()) {
    const { mockRequest } = await import("./mock");
    const res = mockRequest(opts.method ?? "GET", path, opts.body);
    if (res.status >= 400) {
      const err = await toError(new Response(JSON.stringify(res.body), { status: res.status }));
      logPayPalError(`${opts.method ?? "GET"} ${path.split("?")[0]} (mock)`, err);
      throw err;
    }
    return res.body as T;
  }
  const { base } = config();
  const res = await timedFetch(`${base}${path}`, {
    method: opts.method ?? "GET",
    headers: {
      Authorization: `Bearer ${await getAccessToken()}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  if (res.status === 401 && !retried) {
    // Token revoked or rotated server-side: fetch a fresh one once.
    resetTokenCache();
    return paypalRequest<T>(path, opts, true);
  }
  if (!res.ok) {
    const err = await toError(res);
    logPayPalError(`${opts.method ?? "GET"} ${path.split("?")[0]}`, err);
    throw err;
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export interface PayPalAuthStatus {
  ok: boolean;
  /** "rejected" = PayPal refused the credentials (revoked or wrong); "unreachable" = couldn't ask; "unconfigured" = not set. */
  problem?: "rejected" | "unreachable" | "unconfigured";
  error?: string;
}

let authCheck: { at: number; status: PayPalAuthStatus } | null = null;
const AUTH_CHECK_TTL_MS = 5 * 60_000;

/** Asks PayPal for a fresh token (a cached token could outlive a revoked secret) and remembers the answer for 5 minutes,
 * so health checks and page loads don't hammer the auth endpoint. */
export async function checkPayPalAuth(now = Date.now()): Promise<PayPalAuthStatus> {
  if (authCheck && now - authCheck.at < AUTH_CHECK_TTL_MS) return authCheck.status;
  let status: PayPalAuthStatus;
  try {
    if (isMockMode()) status = { ok: true };
    else {
      await fetchAccessToken();
      status = { ok: true };
    }
  } catch (e) {
    const err = e as PayPalError;
    status = { ok: false, problem: err.status === 401 || err.status === 400 ? "rejected" : err.status === 0 ? "unconfigured" : "unreachable", error: err.message };
  }
  authCheck = { at: now, status };
  return status;
}

export function resetAuthCheck() {
  authCheck = null;
}
