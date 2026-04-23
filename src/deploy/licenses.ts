import https from 'node:https';
import type { DeployContext } from '../types.js';
import { azQuiet, azTsv } from '../utils/az.js';
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

  // 104-J: verify-after-write. Re-read the secret from KV and confirm it's
  // a plausible JWT (three base64url parts) before proceeding. Catches the
  // case where `az keyvault secret set` silently truncates a long token
  // (seen once when the shell interpreted an embedded `$` in the payload),
  // or where the vault RBAC isn't yet fully propagated and the write
  // landed on a different scope.
  try {
    const readback = await azTsv(
      `keyvault secret show --vault-name ${ctx.keyVaultName} --name orca-license-master --query value`,
    );
    const parts = readback.split('.');
    if (parts.length !== 3 || !parts.every((p) => p.length > 0)) {
      throw new Error(
        `license master secret does not match 3-part JWT shape (got ${parts.length} parts)`,
      );
    }
    if (readback !== ctx.licenceToken) {
      throw new Error(
        `license master read-back differs from written value (length ${readback.length} vs ${ctx.licenceToken.length})`,
      );
    }
  } catch (err: any) {
    s.fail(`  License master verify failed: ${err.message}`);
    throw err;
  }

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

  // Offline fallback — CHILD licences only. Master stays as the customer's
  // real, verified licence (already written to KV above). 104-S / CL-ORCAHQ-0122:
  // surface a loud, unambiguous warning so the customer knows their connectors
  // are running on short-lived grace tokens until the service is reachable.
  await generateOfflineChildTokens(ctx);
  log.blank();
  log.warn('  ═══════════════════════════════════════════════════════════════');
  log.warn('  OFFLINE LICENCE FALLBACK ACTIVE');
  log.warn('  ───────────────────────────────────────────────────────────────');
  log.warn('  The licence service at license.orcahq.ai was unreachable or');
  log.warn('  returned no child tokens. Your connectors are running on 60-day');
  log.warn('  grace tokens that CARRY NO SIGNATURE and cannot be revoked until');
  log.warn('  re-run. Re-run orca-deploy once connectivity is restored to pick');
  log.warn('  up real signed child tokens. Contact your ORCA representative if');
  log.warn('  the service remains unreachable for more than 24h.');
  log.warn('  ═══════════════════════════════════════════════════════════════');
  log.blank();
  s.succeed(`  ORCA licences provisioned (master from env + offline grace children — SEE WARNING ABOVE)`);
}

/**
 * Offline CHILD grace tokens only. Never writes to orca-license-master —
 * the master is always the customer's real, RS256-verified licence written
 * straight from ctx.licenceToken at the top of provisionLicenses(). Before
 * §104-S this function regenerated the master too, silently invalidating
 * the customer's real licence whenever the licence service was briefly
 * unreachable during install (CL-ORCAHQ-0122).
 */
async function generateOfflineChildTokens(ctx: DeployContext): Promise<void> {
  const crypto = await import('node:crypto');

  const now = Math.floor(Date.now() / 1000);
  const graceDays = 60;
  const exp = now + graceDays * 24 * 60 * 60;

  function createGraceToken(module: string): string {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
      iss: 'orca-deploy-offline',
      sub: ctx.tenantId,
      aud: 'orca-connector',
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

  // Child tokens per connector
  for (const connector of ctx.selectedConnectors) {
    const token = createGraceToken(connector.slug);
    ctx.licenseTokens[connector.slug] = token;
    await azQuiet(
      `keyvault secret set --vault-name ${ctx.keyVaultName} --name orca-license-${connector.slug} --value "${token}"`
    );
  }

  log.success(`  Offline child grace tokens generated (${ctx.selectedConnectors.length} tokens, 60-day expiry, master untouched)`);
}
