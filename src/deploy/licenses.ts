import https from 'node:https';
import type { DeployContext } from '../types.js';
import { azQuiet } from '../utils/az.js';
import * as log from '../utils/log.js';

const LICENSE_SERVICE_URL = 'https://orca-license-service.icyplant-8c8bf272.uksouth.azurecontainerapps.io';

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

  try {
    // Request master + child licences from the licence service
    const connectorSlugs = ctx.selectedConnectors.map(c => c.slug);
    const adminKey = ctx.jwtSigningKey || '';

    const res = await postJson(`${LICENSE_SERVICE_URL}/api/license/issue`, {
      customerTenantId: ctx.tenantId,
      customerId: ctx.customerSlug,
      tier: 'lighthouse',
      connectors: connectorSlugs,
      gracePeriodDays: 60,
    }, adminKey);

    if (res.status >= 200 && res.status < 300 && res.data?.master?.token) {
      // Store master licence in Key Vault
      await azQuiet(
        `keyvault secret set --vault-name ${ctx.keyVaultName} --name orca-license-master --value "${res.data.master.token}"`
      );

      // Store child licences per connector
      for (const child of res.data.children || []) {
        const slug = child.module;
        ctx.licenseTokens[slug] = child.token;
        await azQuiet(
          `keyvault secret set --vault-name ${ctx.keyVaultName} --name orca-license-${slug} --value "${child.token}"`
        );
      }

      s.succeed(`  ORCA licences provisioned (master + ${connectorSlugs.length} child)`);
    } else {
      // Licence service unavailable or error — generate offline grace tokens
      s.warn('  Licence service unavailable — generating offline grace tokens');
      await generateOfflineGraceTokens(ctx);
    }
  } catch (err: any) {
    // Licence service unreachable — fall back to offline grace tokens
    s.warn(`  Licence service unreachable (${err.message}) — generating offline grace tokens`);
    await generateOfflineGraceTokens(ctx);
  }
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
