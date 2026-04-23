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

export async function configureFoundry(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Foundry proxy: foundry.orcahq.ai customer token');

  if (!ctx.licenceToken) {
    s.warn('  Foundry proxy: no licence token on ctx — skipped (legacy path)');
    return;
  }

  try {
    const res = await requestFoundryToken(ctx.licenceToken, ctx.customerSlug);

    if (res.status === 404) {
      s.warn(
        '  Foundry proxy: /api/foundry/token not yet deployed on licence-service — falling back to legacy Foundry keys. Re-run `orca-deploy` after orca-license-service is upgraded to pick up the proxy path.',
      );
      return;
    }

    if (res.status < 200 || res.status >= 300 || typeof res.body === 'string') {
      const detail =
        typeof res.body === 'string' ? res.body.slice(0, 200) : JSON.stringify(res.body).slice(0, 200);
      s.warn(`  Foundry proxy: licence-service returned ${res.status} — ${detail}`);
      return;
    }

    const tokenPayload = res.body;
    if (!tokenPayload.token || !tokenPayload.token.includes('.')) {
      s.warn(
        '  Foundry proxy: licence-service response missing a plausible JWT — falling back to legacy path',
      );
      return;
    }

    ctx.foundryCustomerToken = tokenPayload.token;

    // Store in customer KV so the gateway can consume it via secretRef.
    await azQuiet(
      `keyvault secret set --vault-name ${ctx.keyVaultName} --name foundry-customer-token --value "${tokenPayload.token}"`,
    );

    // Verify-after-write — same pattern as 104-J license master. Compare on
    // shape + length + byte-for-byte after trim. `az ... -o tsv` can append
    // whitespace or \r on some platforms; strip all trailing whitespace to
    // avoid a false "mismatch" warning that confuses the operator into
    // thinking the KV write failed when it actually succeeded.
    const readback = await az(
      `keyvault secret show --vault-name ${ctx.keyVaultName} --name foundry-customer-token --query value -o tsv`,
    );
    const readValue = (readback.stdout || '').replace(/\s+$/g, '');
    const parts = readValue.split('.');
    const shapeOk = parts.length === 3 && parts.every((p) => p.length > 0);
    if (readback.exitCode !== 0 || !shapeOk || readValue.length !== tokenPayload.token.length) {
      s.warn(
        `  Foundry proxy: KV read-back mismatch — falling back to legacy path (exit=${readback.exitCode}, shape_ok=${shapeOk}, len_read=${readValue.length}, len_expect=${tokenPayload.token.length})`,
      );
      return;
    }

    const expiresDays = Math.floor(tokenPayload.expires_in / 86400);
    s.succeed(
      `  Foundry proxy: foundry.orcahq.ai token issued (expires in ~${expiresDays}d), KV secret foundry-customer-token bound`,
    );
  } catch (err: any) {
    s.warn(
      `  Foundry proxy: licence-service unreachable (${err.message}) — legacy Foundry-key path will be used`,
    );
  }
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
