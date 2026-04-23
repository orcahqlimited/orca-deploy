import crypto from 'node:crypto';
import type { DeployContext } from '../types.js';
import { az, azJson, azQuiet, azTsv } from '../utils/az.js';
import { ENTRA_APP_ROLES } from '../utils/config.js';
import * as log from '../utils/log.js';

// Microsoft Graph resource app id
const GRAPH_RESOURCE_ID = '00000003-0000-0000-c000-000000000000';

// Graph application (Role) permissions required for ORCA meeting capture.
// Role IDs sourced from Microsoft Graph service principal.
export const GRAPH_APP_PERMISSIONS: Array<{ name: string; id: string }> = [
  { name: 'CallRecords.Read.All',           id: '45bbb07e-7321-4fd7-a8f6-3ff27e6a81c8' },
  { name: 'OnlineMeetings.Read.All',        id: 'c1684f21-1984-47fa-9d61-2dc8c296bb70' },
  { name: 'OnlineMeetingTranscript.Read.All', id: 'a4a80d8d-d283-4bd8-8504-555ec3870630' },
  { name: 'User.Read.All',                  id: 'df021288-bdef-4463-88db-98f22de89214' },
  { name: 'GroupMember.Read.All',           id: '98830695-27a2-44f7-8c18-0c3ebc9698f6' },
];

export async function createEntraApp(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Entra App Registration: ORCA Intelligence Connectors');

  // Check if the app already exists
  try {
    const existing = await azJson(
      `ad app list --display-name "ORCA Intelligence Connectors" --query "[0].{appId:appId, id:id}"`
    );
    if (existing && existing.appId) {
      // App exists — reuse it
      ctx.entraAppId = existing.appId;

      // Ensure we have the client secret in Key Vault (may already be there)
      try {
        const existingSecret = await azTsv(`keyvault secret show --vault-name ${ctx.keyVaultName} --name entra-client-secret --query value`);
        ctx.entraClientSecret = existingSecret;
      } catch {
        // Secret missing — generate a new one
        const cred = await azJson(
          `ad app credential reset --id ${existing.appId} --display-name "orca-deploy-cli" --years 2 --query "{password:password}"`
        );
        ctx.entraClientSecret = cred.password;
        await azQuiet(`keyvault secret set --vault-name ${ctx.keyVaultName} --name entra-client-id --value "${existing.appId}"`);
        await azQuiet(`keyvault secret set --vault-name ${ctx.keyVaultName} --name entra-client-secret --value "${cred.password.replace(/"/g, '\\"')}"`);
      }

      s.succeed('  Entra App Registration: ORCA Intelligence Connectors (existing — reused)');
      return;
    }
  } catch { /* no existing app — create one */ }

  // Build app roles JSON
  const appRoles = ENTRA_APP_ROLES.map(r => ({
    allowedMemberTypes: ['User'],
    description: r.description,
    displayName: r.displayName,
    id: r.id,
    isEnabled: true,
    value: r.value,
  }));

  // Write temp file for app roles (az ad app create needs file input for complex JSON)
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const rolesFile = path.join(os.tmpdir(), `orca-app-roles-${Date.now()}.json`);
  fs.writeFileSync(rolesFile, JSON.stringify(appRoles));

  try {
    // Create app registration — Claude.ai callback goes under spa.redirectUris,
    // NOT web.redirectUris (CL-ORCAHQ-0133). Claude.ai runs as a browser-based
    // SPA and the Entra token exchange expects the callback registered as an
    // SPA redirect URI (which issues tokens without a client secret via PKCE).
    // Registering it under web.redirectUris causes the OAuth flow to fail with
    // AADSTS9002325 "cross-origin token redemption is permitted only for the
    // 'Single-Page Application' client type". We create the app without any
    // redirect URI first, then PATCH the SPA redirect URI via Graph — `az ad
    // app create` exposes --web-redirect-uris and --public-client-redirect-uris
    // but has no flag for the SPA bucket.
    const app = await azJson(
      `ad app create --display-name "ORCA Intelligence Connectors" --sign-in-audience AzureADMyOrg --app-roles @${rolesFile} --query "{appId:appId, id:id}"`
    );

    ctx.entraAppId = app.appId;

    // Set spa.redirectUris via Graph PATCH (104-H). Use printf-style escaping
    // for the shell — this body is small and static.
    await azQuiet(
      `rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/${app.id}" --headers "Content-Type=application/json" --body '{"spa":{"redirectUris":["https://claude.ai/api/mcp/auth_callback"]}}'`,
    );

    // Create service principal
    await azQuiet(`ad sp create --id ${app.appId}`);

    // Create client secret (2 year expiry)
    const cred = await azJson(
      `ad app credential reset --id ${app.appId} --display-name "orca-deploy-cli" --years 2 --query "{password:password}"`
    );
    ctx.entraClientSecret = cred.password;

    // Store in Key Vault
    await azQuiet(`keyvault secret set --vault-name ${ctx.keyVaultName} --name entra-client-id --value "${app.appId}"`);
    await azQuiet(`keyvault secret set --vault-name ${ctx.keyVaultName} --name entra-client-secret --value "${cred.password.replace(/"/g, '\\"')}"`);

    // Grant admin consent
    await azQuiet(`ad app permission admin-consent --id ${app.appId}`).catch(() => {
      // May fail if no API permissions defined — that's OK for connectors
    });

    s.succeed('  Entra App Registration: ORCA Intelligence Connectors (5 roles, secret stored)');
  } finally {
    fs.unlinkSync(rolesFile);
  }
}

export async function updateEntraRedirectUris(ctx: DeployContext): Promise<void> {
  const s = log.spinner('Updating Entra redirect URIs');

  // Split redirect URIs by OAuth client type (CL-ORCAHQ-0133):
  //   spa.redirectUris — browser-SPA flows with PKCE (Claude.ai connector)
  //   web.redirectUris — confidential-client flows with a client secret
  //                      (connector OAuth callbacks, gateway MCP callback)
  //
  // Registering Claude.ai's callback on web.redirectUris fails with
  // AADSTS9002325. Registering the connector/gateway callbacks on SPA
  // breaks the confidential-client exchange. Treat them separately.
  const spaUris: string[] = ['https://claude.ai/api/mcp/auth_callback'];
  const webUris: string[] = [];

  for (const [_slug, fqdn] of Object.entries(ctx.connectorFqdns)) {
    webUris.push(`https://${fqdn}/oauth/callback`);
  }

  // Gateway OAuth callbacks — both Azure-assigned FQDN and, if bound, the
  // customer's custom domain. Both must be registered so either hostname
  // can complete OAuth flows.
  if (ctx.gatewayFqdn) {
    webUris.push(`https://${ctx.gatewayFqdn}/api/mcp/auth_callback`);
  }
  if (ctx.customGatewayDomainBound && ctx.customGatewayDomain) {
    webUris.push(`https://${ctx.customGatewayDomain}/api/mcp/auth_callback`);
  }

  // Resolve the application object id (required by the Graph PATCH url)
  // from the appId we already have in ctx.
  const objectId = await azTsv(
    `ad app show --id ${ctx.entraAppId} --query id`,
  );

  // Single Graph PATCH sets both buckets atomically.
  const body = JSON.stringify({
    spa: { redirectUris: spaUris },
    web: { redirectUris: webUris },
  }).replace(/"/g, '\\"');
  await azQuiet(
    `rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/${objectId}" --headers "Content-Type=application/json" --body "${body}"`,
  );

  s.succeed(
    `  Entra redirect URIs updated (${spaUris.length} spa + ${webUris.length} web)`,
  );
}
