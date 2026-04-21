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
    // Create app registration — initially with just claude.ai callback
    const app = await azJson(
      `ad app create --display-name "ORCA Intelligence Connectors" --sign-in-audience AzureADMyOrg --app-roles @${rolesFile} --web-redirect-uris "https://claude.ai/api/mcp/auth_callback" --query "{appId:appId, id:id}"`
    );

    ctx.entraAppId = app.appId;

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

  const uris = ['https://claude.ai/api/mcp/auth_callback'];
  for (const [slug, fqdn] of Object.entries(ctx.connectorFqdns)) {
    uris.push(`https://${fqdn}/oauth/callback`);
  }

  // Gateway OAuth callbacks — both Azure-assigned FQDN and, if bound, the
  // customer's custom domain. Both must be registered so either hostname
  // can complete OAuth flows.
  if (ctx.gatewayFqdn) {
    uris.push(`https://${ctx.gatewayFqdn}/api/mcp/auth_callback`);
  }
  if (ctx.customGatewayDomainBound && ctx.customGatewayDomain) {
    uris.push(`https://${ctx.customGatewayDomain}/api/mcp/auth_callback`);
  }

  await azQuiet(`ad app update --id ${ctx.entraAppId} --web-redirect-uris ${uris.map(u => `"${u}"`).join(' ')}`);

  s.succeed(`  Entra redirect URIs updated (${uris.length} URIs)`);
}
