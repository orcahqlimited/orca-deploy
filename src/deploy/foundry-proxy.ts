import https from 'node:https';
import type { DeployContext } from '../types.js';
import { az, azQuiet } from '../utils/az.js';
import * as log from '../utils/log.js';

// INTENT-ORCAHQ-104 §104-I — configureFoundry (proxy edition).
//
// Points the customer gateway at https://foundry.orcahq.ai (the Cloudflare
// Worker shipped under INTENT-104 §104-Z). HQ Foundry API keys stay in the
// Worker's secret store; the customer holds only a short-lived JWT that
// the Worker verifies against the licence-service JWKS.
//
// Three outputs:
//   1. KV secret `foundry-customer-token` — JWT issued by
//      orca-license-service /api/foundry/token, authenticated by the
//      master licence.
//   2. Gateway env vars (set later when the Container App is created):
//        FOUNDRY_ENDPOINT         = https://foundry.orcahq.ai
//        FOUNDRY_CUSTOMER_SLUG    = <ctx.customerSlug>
//        FOUNDRY_CUSTOMER_TOKEN   = secretRef -> foundry-customer-token
//   3. ctx.foundryCustomerToken set for downstream use.
//
// Graceful degradation: if the licence-service endpoint isn't yet deployed
// (404), the installer warns + continues — the gateway will still boot
// with the legacy Foundry-key path configured elsewhere. Flag on the
// Deployment Plan so the customer knows they are on the legacy route.

const FOUNDRY_PROXY_URL = 'https://foundry.orcahq.ai';
const LICENSE_SERVICE_URL =
  process.env.LICENSE_SERVICE_URL || 'https://license.orcahq.ai';

interface FoundryTokenResponse {
  token: string;
  expires_in: number;
  audience?: string;
}

// Transport-error classification. The AgileCadence redeploy 2026-04-26
// hit a corporate-proxy-induced TLS EOF on this exact call (long PUT
// over a network with deep packet inspection); the original code
// caught the rejection and `s.warn`'d it, so the install reported
// success while leaving the KV secret unset. TASK-111 fixes that.
const TRANSPORT_ERROR_PATTERNS = [
  /TLS|SSL/i,
  /ECONNRESET|ECONNREFUSED|ECONNABORTED/i,
  /ENOTFOUND|EAI_AGAIN/i,
  /EHOSTUNREACH|ENETUNREACH/i,
  /EPIPE|EOF/i,
  /timeout/i,
  /socket hang up/i,
];

function isTransportError(err: any): boolean {
  const msg = String(err?.message || err || '');
  return TRANSPORT_ERROR_PATTERNS.some((p) => p.test(msg));
}

function requestFoundryToken(
  masterJwt: string,
  customerSlug: string,
): Promise<{ status: number; body: FoundryTokenResponse | string }> {
  return new Promise((resolve, reject) => {
    const url = new URL(`${LICENSE_SERVICE_URL}/api/foundry/token`);
    const payload = JSON.stringify({ customer_slug: customerSlug });
    const req = https.request(
      {
        hostname: url.hostname,
        port: 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${masterJwt}`,
        },
        timeout: 30_000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode || 0,
              body: JSON.parse(data) as FoundryTokenResponse,
            });
          } catch {
            resolve({ status: res.statusCode || 0, body: data });
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('foundry token request timeout (30s)'));
    });
    req.write(payload);
    req.end();
  });
}

// Retry transport-level failures with exponential backoff. The AC
// redeploy showed transient TLS EOF on corporate networks; retrying
// twice (5s, 15s) absorbs most of those without operator intervention.
// HTTP error responses (4xx/5xx) are NOT retried here — those come
// back via `status` and the caller decides what to do.
async function requestFoundryTokenWithRetry(
  masterJwt: string,
  customerSlug: string,
): Promise<
  | { kind: 'response'; status: number; body: FoundryTokenResponse | string }
  | { kind: 'transport_error'; attempts: number; lastError: string }
> {
  const backoffsMs = [5_000, 15_000];
  let lastError: any = null;
  for (let attempt = 1; attempt <= backoffsMs.length + 1; attempt++) {
    try {
      const res = await requestFoundryToken(masterJwt, customerSlug);
      return { kind: 'response', status: res.status, body: res.body };
    } catch (err: any) {
      lastError = err;
      if (!isTransportError(err)) {
        // Non-transport error — return as transport_error anyway, with the
        // raw message. The caller treats anything that prevented an HTTP
        // response from arriving as a transport-class failure.
        return { kind: 'transport_error', attempts: attempt, lastError: String(err?.message || err) };
      }
      if (attempt > backoffsMs.length) break;
      const wait = backoffsMs[attempt - 1];
      log.dim(`    Foundry token request failed (${err.message}) — retrying in ${wait / 1000}s (attempt ${attempt + 1}/${backoffsMs.length + 1})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return {
    kind: 'transport_error',
    attempts: backoffsMs.length + 1,
    lastError: String(lastError?.message || lastError || 'unknown transport error'),
  };
}

export async function configureFoundry(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Foundry proxy: foundry.orcahq.ai customer token');

  if (!ctx.licenceToken) {
    s.warn('  Foundry proxy: no licence token on ctx — skipped (legacy path)');
    return;
  }

  // requestFoundryTokenWithRetry never throws on transport errors; it
  // returns `{ kind: 'transport_error', ... }`. HTTP responses (any
  // status) come back as `{ kind: 'response', ... }`. The whole try/
  // catch is gone on purpose — the AC 2026-04-26 silent-fail bug
  // (TASK-111) was that the catch block swallowed transport errors
  // as warns; this version surfaces them as install-summary entries.
  const res = await requestFoundryTokenWithRetry(ctx.licenceToken, ctx.customerSlug);

  if (res.kind === 'transport_error') {
    // Transport-class failure — TLS interception, DNS, timeout, etc.
    // Do NOT classify this as "skipped, fall back to legacy" — the
    // gateway will land without a token and every Foundry call from
    // it will return 401 from the Worker. Mark the failure on ctx
    // so the install summary + phone-home can surface it.
    ctx.foundryConfigureFailed = true;
    ctx.foundryConfigureFailReason = `transport: ${res.lastError} (after ${res.attempts} attempts)`;
    s.fail(
      `  Foundry proxy: licence-service unreachable after ${res.attempts} attempts — ${res.lastError}`,
    );
    log.warn('    ACTION REQUIRED before the gateway can call Foundry:');
    log.dim(
      `      1. Confirm the deploy host can reach ${LICENSE_SERVICE_URL} (corporate proxies / DPI / TLS interception are the usual culprit).`,
    );
    log.dim(
      `      2. Re-run \`orca-deploy\` (configureFoundry is idempotent — it'll pick up the existing licence + KV state).`,
    );
    log.dim(
      `      3. Or run the manual fallback: curl ${LICENSE_SERVICE_URL}/api/foundry/token \\`,
    );
    log.dim(
      `         with Authorization: Bearer <licence>, then store the returned JWT in KV as foundry-customer-token.`,
    );
    return;
  }

  if (res.status === 404) {
    // 404 is a legitimate "endpoint not deployed yet" path — the older
    // gateway image (pre-1b09acd) still works without the proxy token,
    // so this is the only branch where "fall back to legacy" is true.
    s.warn(
      '  Foundry proxy: /api/foundry/token not yet deployed on licence-service — falling back to legacy Foundry keys. Re-run `orca-deploy` after orca-license-service is upgraded to pick up the proxy path.',
    );
    return;
  }

  if (res.status < 200 || res.status >= 300 || typeof res.body === 'string') {
    // 4xx/5xx — licence-service is reachable but returned an error.
    // Mark as configure-failed (same severity as transport failure)
    // so the install summary surfaces it.
    const detail =
      typeof res.body === 'string' ? res.body.slice(0, 200) : JSON.stringify(res.body).slice(0, 200);
    ctx.foundryConfigureFailed = true;
    ctx.foundryConfigureFailReason = `http ${res.status}: ${detail}`;
    s.fail(`  Foundry proxy: licence-service returned ${res.status} — ${detail}`);
    log.warn('    ACTION REQUIRED — the gateway will start without a Foundry-proxy token until this is resolved.');
    return;
  }

  const tokenPayload = res.body as FoundryTokenResponse;
  if (!tokenPayload.token || !tokenPayload.token.includes('.')) {
    ctx.foundryConfigureFailed = true;
    ctx.foundryConfigureFailReason = 'licence-service response missing a plausible JWT';
    s.fail(
      '  Foundry proxy: licence-service response missing a plausible JWT — gateway will start without a Foundry-proxy token',
    );
    return;
  }

  ctx.foundryCustomerToken = tokenPayload.token;

  // Store in customer KV so the gateway can consume it via secretRef.
  await azQuiet(
    `keyvault secret set --vault-name ${ctx.keyVaultName} --name foundry-customer-token --value "${tokenPayload.token}"`,
  );

  // Verify-after-write — same pattern as 104-J license master. We trust
  // the content check (JWT shape + byte-for-byte equality after trim) as
  // the source of truth. az CLI's exit code can be non-zero even when
  // the query returned the correct value (CL-ORCAHQ-0103 — warnings on
  // stderr, flaky KV RBAC, containerapp-extension hook noise), so we
  // treat exit-code-only failures as diagnostic rather than blocking.
  //
  // `az ... -o tsv` can append \r or extra newlines depending on
  // platform — strip trailing whitespace before comparing.
  const readback = await az(
    `keyvault secret show --vault-name ${ctx.keyVaultName} --name foundry-customer-token --query value -o tsv`,
  );
  const readValue = (readback.stdout || '').replace(/\s+$/g, '');
  const parts = readValue.split('.');
  const shapeOk = parts.length === 3 && parts.every((p) => p.length > 0);
  const contentOk = readValue === tokenPayload.token;
  if (!shapeOk || !contentOk) {
    ctx.foundryConfigureFailed = true;
    ctx.foundryConfigureFailReason = `KV read-back mismatch (exit=${readback.exitCode}, shape_ok=${shapeOk}, content_match=${contentOk})`;
    s.fail(
      `  Foundry proxy: KV read-back mismatch — gateway will start without a Foundry-proxy token (exit=${readback.exitCode}, shape_ok=${shapeOk}, content_match=${contentOk}, len_read=${readValue.length}, len_expect=${tokenPayload.token.length})`,
    );
    return;
  }
  // Content matched. If az also returned non-zero, log diagnostic only
  // so the anomaly surfaces without blocking the install.
  if (readback.exitCode !== 0) {
    log.dim(
      `    (az read-back exit=${readback.exitCode} but content matches; accepting)`,
    );
  }

  const expiresDays = Math.floor(tokenPayload.expires_in / 86400);
  s.succeed(
    `  Foundry proxy: foundry.orcahq.ai token issued (expires in ~${expiresDays}d), KV secret foundry-customer-token bound`,
  );
}

export function foundryProxyEnvVars(
  ctx: DeployContext,
): { plain: Record<string, string>; secretRefs: Record<string, string> } {
  // Plain env vars are set on the Container App directly; secretRefs point
  // at the bound KV secret. Returns empty mappings if no token was issued,
  // so the legacy Foundry-key wiring downstream is untouched.
  if (!ctx.foundryCustomerToken) {
    return { plain: {}, secretRefs: {} };
  }
  return {
    plain: {
      FOUNDRY_ENDPOINT: FOUNDRY_PROXY_URL,
      FOUNDRY_CUSTOMER_SLUG: ctx.customerSlug,
    },
    secretRefs: {
      FOUNDRY_CUSTOMER_TOKEN: 'foundry-customer-token',
    },
  };
}
