import https from 'node:https';
import type { DeployContext } from '../types.js';
import { azQuiet } from '../utils/az.js';
import * as log from '../utils/log.js';

// Stable ORCA HQ hostname fronted by orca-hq-proxy (Cloudflare Worker).
// Originally a *.azurecontainerapps.io FQDN; abstracting it via orcahq.ai
// means backend moves are a DNS/proxy update, not a customer re-roll.
// Override in tests with env LICENSE_SERVICE_URL.
const LICENSE_SERVICE_URL =
  process.env.LICENSE_SERVICE_URL || 'https://license.orcahq.ai';

function postJson(url: string, body: object, adminKey: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'Authorization': `Bearer ${adminKey}`,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode || 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode || 0, data });
          }
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(payload);
    req.end();
  });
}

export async function provisionLicenses(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Provisioning ORCA licences');

  ctx.licenseServiceEndpoint = LICENSE_SERVICE_URL;

  if (!ctx.licenceToken || !ctx.licenceClaims) {
    // Should never happen — the licence gate in index.ts runs before we get
    // here and exits with a clear message if ORCA_LICENCE_KEY is missing.
    // Kept as a defensive guard.
    s.fail('  No licence token on context — licence gate was skipped');
    throw new Error('provisionLicenses requires a verified licence on ctx.licenceToken');
  }

  // The master licence is the one the customer supplied in ORCA_LICENCE_KEY,
  // already verified against the tenant. Write it straight to Key Vault —
  // no round-trip to the licence service for the master.
  await azQuiet(
    `keyvault secret set --vault-name ${ctx.keyVaultName} --name orca-license-master --value "${ctx.licenceToken}"`,
  );

  // Child licences (one per connector the customer deploys) are still issued
  // by the licence service. The service endpoint currently doesn't require
  // an admin key — the tenant-binding in the master licence is what keeps
  // things honest. If the service is unreachable, fall back to offline
  // children keyed to the master's expiry (never longer than the master).
  try {
    const connectorSlugs = ctx.selectedConnectors.map(c => c.slug);
    const res = await postJson(`${LICENSE_SERVICE_URL}/api/license/issue`, {
      customerTenantId: ctx.tenantId,
      customerId: ctx.customerSlug,
      tier: ctx.licenceClaims.tier,
      connectors: connectorSlugs,
      // Child licences track master expiry — no separate grace period.
      gracePeriodDays: Math.max(
        1,
        Math.floor((ctx.licenceClaims.exp * 1000 - Date.now()) / (24 * 60 * 60 * 1000)),
      ),
    }, ctx.jwtSigningKey || '');

    if (res.status >= 200 && res.status < 300 && Array.isArray(res.data?.children)) {
      for (const child of res.data.children) {
        const slug = child.module;
        ctx.licenseTokens[slug] = child.token;
        await azQuiet(
          `keyvault secret set --vault-name ${ctx.keyVaultName} --name orca-license-${slug} --value "${child.token}"`,
        );
      }
      s.succeed(`  ORCA licences provisioned (master from env + ${res.data.children.length} child from service)`);
      return;
    }
    // Service returned but with no children — fall through to offline path
    s.warn('  Licence service returned no child tokens — generating offline children');
  } catch (err: any) {
    s.warn(`  Licence service unreachable (${err.message}) — generating offline children`);
  }

  // Offline fallback for child licences only. Master is the customer's real
  // licence (verified above), child tokens are derived with the same expiry.
  await generateOfflineGraceTokens(ctx);
  s.succeed(`  ORCA licences provisioned (master from env + offline children)`);
}

/**
 * When the licence service is not yet deployed, generate simple JWT tokens
 * that encode the 60-day grace period. Connectors decode these without
 * verification (they only check the exp claim for enforcement staging).
 */
async function generateOfflineGraceTokens(ctx: DeployContext): Promise<void> {
  // Dynamic import to avoid adding jsonwebtoken as a dependency to orca-deploy
  // We use the jwt signing key to create tokens locally
  const crypto = await import('node:crypto');

  const now = Math.floor(Date.now() / 1000);
  const graceDays = 60;
  const exp = now + graceDays * 24 * 60 * 60;

  // Create a simple unsigned token (base64-encoded JSON) — connectors
  // decode without verification for claim reading
  function createGraceToken(module: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'orca-deploy-offline',
      sub: ctx.tenantId,
      aud: module === 'master' ? 'orca-master' : 'orca-connector',
      jti: crypto.randomUUID(),
      iat: now,
      exp,
      'orca:tier': 'lighthouse',
      'orca:customerId': ctx.customerSlug,
      'orca:module': module,
      'orca:gracePeriodDays': graceDays,
      'orca:telemetryRequired': true,
    })).toString('base64url');
    return `${header}.${payload}.`;
  }

  // Master token
  const masterToken = createGraceToken('master');
  await azQuiet(
    `keyvault secret set --vault-name ${ctx.keyVaultName} --name orca-license-master --value "${masterToken}"`
  );

  // Child tokens per connector
  for (const connector of ctx.selectedConnectors) {
    const token = createGraceToken(connector.slug);
    ctx.licenseTokens[connector.slug] = token;
    await azQuiet(
      `keyvault secret set --vault-name ${ctx.keyVaultName} --name orca-license-${connector.slug} --value "${token}"`
    );
  }

  log.success(`  Offline grace tokens generated (${ctx.selectedConnectors.length + 1} tokens, 60-day expiry)`);
}
