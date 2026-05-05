// Core ORCA product Container Apps — gateway, copilot, governance portal,
// licence service. Each function is idempotent (check-exists-then-create-or-update),
// binds Key Vault secrets BEFORE setting secretRef env vars (CL-ORCAHQ-0105),
// and always passes the FULL env var set on update (CL-2026-0072).
//
// The customer tenant deploys into the same Container Apps Environment as the
// connectors (ctx.caEnvironment). A dedicated VNet-integrated environment is
// an ORCA HQ deployment detail that we do not require for customer deployments
// — the shared CAE is sufficient for single-tenant isolation.

import crypto from 'node:crypto';
import type { DeployContext } from '../types.js';
import { az, azQuiet, azTsv, azJson } from '../utils/az.js';
import { IMAGE_TAGS } from '../utils/config.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';
import { bindCustomGatewayDomain } from './custom-domain.js';

// ORCA HQ's support API — tickets route here regardless of customer tenant
// (see ORCAHQ-CUSTOMER-DEPLOYMENT-001.md §2.2). Not customer-owned.
// Addressed via the orcahq.ai proxy so we can move the backend without
// breaking customer-side support ticket submission.
const ORCA_HQ_SUPPORT_API_URL = 'https://support-api.orcahq.ai';

// Foundry endpoint defaults — customer either brings their own (override via env)
// or uses the shared ORCA HQ endpoints per licence terms.
const FOUNDRY_ENDPOINT_PRIMARY =
  process.env.FOUNDRY_ENDPOINT_PRIMARY || 'https://uksouth.api.cognitive.microsoft.com';
const FOUNDRY_ENDPOINT_SWC =
  process.env.FOUNDRY_ENDPOINT_SWC || 'https://swedencentral.api.cognitive.microsoft.com';

// =============================================================================
// Licence service — if not already deployed, stand up the Container App that
// accepts the offline grace tokens provisioned in licenses.ts. This is thin:
// most customers will hit the ORCA HQ-hosted service first; this local instance
// is only for the air-gap case.
// =============================================================================

export async function deployLicenseService(ctx: DeployContext): Promise<void> {
  const appName = naming.licenseServiceAppName(ctx.customerSlug);
  const tag = IMAGE_TAGS['orca-license-service'] || 'rc-latest';
  const image = `${ctx.acrLoginServer}/orca-license-service:${tag}`;

  const s = log.spinner(`Creating ${appName} Container App`);

  const plainEnvVars = [
    'NODE_ENV=production',
    'DEV_MODE=false',
    'PORT=3000',
    'APPINSIGHTS_ENABLE_REQUEST_BODY=false',
    `KEY_VAULT_NAME=${ctx.keyVaultName}`,
    `AZURE_CLIENT_ID=${ctx.miClientId}`,
    `TENANT_ID=${ctx.tenantId}`,
    `CUSTOMER_SLUG=${ctx.customerSlug}`,
  ];

  const existing = await az(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup}`
  );

  if (existing.exitCode === 0) {
    s.text = `Updating existing ${appName} Container App`;
    await azQuiet(
      `containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} ` +
        `--image ${image} --set-env-vars ${plainEnvVars.join(' ')}`
    );
  } else {
    await azQuiet(
      [
        `containerapp create`,
        `--name ${appName}`,
        `--resource-group ${ctx.resourceGroup}`,
        `--environment ${ctx.caEnvironment}`,
        `--image ${image}`,
        `--ingress internal --target-port 3000`,
        `--min-replicas 1 --max-replicas 2`,
        `--cpu 0.25 --memory 0.5Gi`,
        `--registry-server ${ctx.acrLoginServer}`,
        `--registry-identity "${ctx.miId}"`,
        `--user-assigned "${ctx.miId}"`,
        `--env-vars ${plainEnvVars.join(' ')}`,
      ].join(' ')
    );
  }

  const fqdn = await azTsv(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--query "properties.configuration.ingress.fqdn"`
  );
  ctx.licenseServiceFqdn = fqdn;
  ctx.licenseServiceEndpoint = `https://${fqdn}`;

  s.succeed(`  ${appName} deployed (${fqdn})`);
}

// =============================================================================
// Gateway — the 6-tool MCP surface. Shares the connector managed identity
// (ctx.miId) so it has AcrPull + KV Secrets User already.
// =============================================================================

export async function deployGateway(ctx: DeployContext): Promise<void> {
  const appName = naming.gatewayAppName(ctx.customerSlug);
  const tag = IMAGE_TAGS['orca-mcp-gateway'] || 'rc-latest';
  const image = `${ctx.acrLoginServer}/orca-mcp-gateway:${tag}`;

  const s = log.spinner(`Creating ${appName} Container App`);

  // Generate heartbeat secret + graph-webhook client state if missing. These
  // are customer-owned — written to KV so copilot + gateway can share.
  if (!ctx.heartbeatSecret) {
    ctx.heartbeatSecret = crypto.randomBytes(32).toString('hex');
    await azQuiet(
      `keyvault secret set --vault-name ${ctx.keyVaultName} --name heartbeat-secret ` +
        `--value "${ctx.heartbeatSecret}"`
    );
  }
  if (!ctx.graphWebhookClientState) {
    ctx.graphWebhookClientState = crypto.randomBytes(16).toString('hex');
    await azQuiet(
      `keyvault secret set --vault-name ${ctx.keyVaultName} --name graph-webhook-client-state ` +
        `--value "${ctx.graphWebhookClientState}"`
    );
  }

  // Step 1: Plain env vars only — safe for create. Matches the ORCA HQ gateway
  // deploy.sh env var set, adjusted to customer values.
  const plainEnvVars = [
    'NODE_ENV=production',
    'DEV_MODE=false',
    'PORT=3000',
    'APPINSIGHTS_ENABLE_REQUEST_BODY=false',
    'WRITE_ENABLED_PRACTICE_BRAIN=true',
    'PROPOSAL_REQUIRED_PRACTICE_BRAIN=true',
    'CHALLENGER_ENABLED=true',
    'SIMPLEX_ENABLED=false',
    'SEARCH_SHADOW_MODE=false',
    'SEARCH_V2_ENABLED=true',
    'EMBED_MODEL=foundry',
    'FOUNDRY_DEPLOYMENT_NAME=phi-4',
    'FOUNDRY_EMBEDDING_DEPLOYMENT_NAME=text-embedding-3-small',
    `FOUNDRY_ENDPOINT=${FOUNDRY_ENDPOINT_PRIMARY}`,
    `FOUNDRY_SWC_ENDPOINT=${FOUNDRY_ENDPOINT_SWC}`,
    `KEY_VAULT_NAME=${ctx.keyVaultName}`,
    `ENTRA_TENANT_ID=${ctx.tenantId}`,
    `AZURE_CLIENT_ID=${ctx.miClientId}`,
    `QDRANT_URL=${ctx.qdrantInternalUrl || 'http://qdrant:6333'}`,
    `SUPPORT_API_URL=${ORCA_HQ_SUPPORT_API_URL}`,
    // INTENT-104 §104-DD — HQ Observability Bridge opt-out passthrough.
    // Default: customer posts errors/warnings/aggregates to telemetry.orcahq.ai.
    // Set `ORCA_TELEMETRY=off` on the `docker run` invocation to disable.
    `ORCA_TELEMETRY=${process.env.ORCA_TELEMETRY || 'on'}`,
  ];

  if (ctx.eligibilityGroupOid) {
    plainEnvVars.push(
      `MEETING_CAPTURE_ELIGIBILITY_GROUP_OID=${ctx.eligibilityGroupOid}`
    );
  }

  const existing = await az(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup}`
  );

  if (existing.exitCode === 0) {
    s.text = `Updating existing ${appName} Container App`;
    await azQuiet(
      `containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} ` +
        `--image ${image} --set-env-vars ${plainEnvVars.join(' ')}`
    );
  } else {
    await azQuiet(
      [
        `containerapp create`,
        `--name ${appName}`,
        `--resource-group ${ctx.resourceGroup}`,
        `--environment ${ctx.caEnvironment}`,
        `--image ${image}`,
        `--ingress external --target-port 3000`,
        `--min-replicas 1 --max-replicas 3`,
        `--cpu 0.5 --memory 1.0Gi`,
        `--registry-server ${ctx.acrLoginServer}`,
        `--registry-identity "${ctx.miId}"`,
        `--user-assigned "${ctx.miId}"`,
        `--env-vars ${plainEnvVars.join(' ')}`,
      ].join(' ')
    );
  }

  // Step 2: FQDN
  const fqdn = await azTsv(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--query "properties.configuration.ingress.fqdn"`
  );
  ctx.gatewayFqdn = fqdn;
  ctx.gatewayUrl = `https://${fqdn}`;

  // Step 3: bind KV secrets BEFORE setting secretRef env vars (CL-ORCAHQ-0105).
  // The gateway's shared Entra client secret reuses ctx.entraClientSecret which
  // is already stored in KV as entra-client-secret by entra.ts.
  const kvSecrets: string[] = [
    `entra-client-secret=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/entra-client-secret,identityref:${ctx.miId}`,
    `heartbeat-secret=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/heartbeat-secret,identityref:${ctx.miId}`,
    `graph-webhook-client-state=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/graph-webhook-client-state,identityref:${ctx.miId}`,
  ];
  // Optional secrets — only bind if the operator supplied a value during prompting.
  const optionalKvSecretNames = [
    'foundry-api-key',
    'foundry-api-key-swc',
    'app-insights-conn-string',
    'sql-connection-string',
    'anthropic-api-key',
  ];
  for (const name of optionalKvSecretNames) {
    if (ctx.credentials[name]) {
      kvSecrets.push(
        `${name}=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/${name},identityref:${ctx.miId}`
      );
    }
  }

  // INTENT-104 §104-I — bind the Foundry proxy customer token if
  // configureFoundry() successfully issued one. Presence of
  // ctx.foundryCustomerToken is the discriminator between "proxy mode"
  // (customer uses foundry.orcahq.ai, no HQ keys in their KV) and legacy
  // mode (direct-to-Foundry with an api-key).
  if (ctx.foundryCustomerToken) {
    kvSecrets.push(
      `foundry-customer-token=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/foundry-customer-token,identityref:${ctx.miId}`,
    );
  }
  await azQuiet(
    `containerapp secret set --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--secrets ${kvSecrets.map((s) => `"${s}"`).join(' ')}`
  );

  // Step 4: full env var set including secret refs + runtime-resolved URLs
  const allEnvVars = [
    ...plainEnvVars,
    `GATEWAY_URL=${ctx.gatewayUrl}`,
    `CLIENT_ID=${ctx.entraAppId}`,
    'CLIENT_SECRET=secretref:entra-client-secret',
    'HEARTBEAT_SECRET=secretref:heartbeat-secret',
    'GRAPH_WEBHOOK_CLIENT_STATE=secretref:graph-webhook-client-state',
  ];
  if (ctx.copilotUrl) {
    allEnvVars.push(`COPILOT_URL=${ctx.copilotUrl}`);
  }
  if (ctx.licenseServiceEndpoint) {
    allEnvVars.push(`ORCA_LICENSE_ENDPOINT=${ctx.licenseServiceEndpoint}`);
  }
  if (ctx.graphSubscriptionId) {
    allEnvVars.push(`GRAPH_SUBSCRIPTION_ID=${ctx.graphSubscriptionId}`);
  }
  if (ctx.credentials['foundry-api-key']) {
    allEnvVars.push('FOUNDRY_API_KEY=secretref:foundry-api-key');
  }
  if (ctx.credentials['foundry-api-key-swc']) {
    allEnvVars.push('FOUNDRY_SWC_API_KEY=secretref:foundry-api-key-swc');
  }

  // INTENT-104 §104-I — Foundry proxy mode. Overrides FOUNDRY_ENDPOINT set
  // in plainEnvVars + gateway reads FOUNDRY_CUSTOMER_TOKEN via secretRef +
  // attaches Authorization: Bearer instead of the Azure api-key header.
  if (ctx.foundryCustomerToken) {
    const proxyIdx = allEnvVars.findIndex((v) => v.startsWith('FOUNDRY_ENDPOINT='));
    if (proxyIdx >= 0) {
      allEnvVars[proxyIdx] = 'FOUNDRY_ENDPOINT=https://foundry.orcahq.ai';
    } else {
      allEnvVars.push('FOUNDRY_ENDPOINT=https://foundry.orcahq.ai');
    }
    allEnvVars.push(`FOUNDRY_CUSTOMER_SLUG=${ctx.customerSlug}`);
    allEnvVars.push('FOUNDRY_CUSTOMER_TOKEN=secretref:foundry-customer-token');
  }
  if (ctx.credentials['app-insights-conn-string']) {
    allEnvVars.push('APPINSIGHTS_CONNECTION_STRING=secretref:app-insights-conn-string');
  }
  if (ctx.credentials['sql-connection-string']) {
    allEnvVars.push('SQL_CONNECTION_STRING=secretref:sql-connection-string');
  }
  if (ctx.credentials['anthropic-api-key']) {
    allEnvVars.push('ANTHROPIC_API_KEY=secretref:anthropic-api-key');
  }

  await azQuiet(
    `containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--set-env-vars ${allEnvVars.join(' ')}`
  );

  s.succeed(`  ${appName} deployed (${fqdn})`);
}

// =============================================================================
// Copilot — Guardian for Teams. Needs its own Entra app (SingleTenant bot per
// CL-ORCAHQ-0111). The Bot Service itself requires higher permissions than this
// CLI typically has, so we document what's needed but create the Container App
// portion idempotently. If the Bot Service resource cannot be created, copilot
// will still deploy but Teams channel registration must be completed manually.
// =============================================================================

async function ensureCopilotEntraApp(ctx: DeployContext): Promise<void> {
  if (ctx.copilotEntraAppId) return;

  const displayName = naming.copilotEntraAppName(ctx.customerSlug);

  try {
    const existing = await azJson(
      `ad app list --display-name "${displayName}" --query "[0].{appId:appId, id:id}"`
    );
    if (existing && existing.appId) {
      ctx.copilotEntraAppId = existing.appId;
      // Recover or reset secret
      try {
        const kvSecret = await azTsv(
          `keyvault secret show --vault-name ${ctx.keyVaultName} --name copilot-client-secret ` +
            `--query value`
        );
        ctx.copilotEntraClientSecret = kvSecret;
      } catch {
        const cred = await azJson(
          `ad app credential reset --id ${existing.appId} --display-name "orca-deploy-cli" ` +
            `--years 2 --query "{password:password}"`
        );
        ctx.copilotEntraClientSecret = cred.password;
        await azQuiet(
          `keyvault secret set --vault-name ${ctx.keyVaultName} --name copilot-client-secret ` +
            `--value "${cred.password.replace(/"/g, '\\"')}"`
        );
      }
      return;
    }
  } catch {
    /* no existing app */
  }

  // Create a new SingleTenant Entra app for the Copilot bot. No app roles —
  // plugin audience is the bot itself.
  const app = await azJson(
    `ad app create --display-name "${displayName}" --sign-in-audience AzureADMyOrg ` +
      `--query "{appId:appId, id:id}"`
  );
  ctx.copilotEntraAppId = app.appId;
  await azQuiet(`ad sp create --id ${app.appId}`).catch(() => {});

  const cred = await azJson(
    `ad app credential reset --id ${app.appId} --display-name "orca-deploy-cli" --years 2 ` +
      `--query "{password:password}"`
  );
  ctx.copilotEntraClientSecret = cred.password;
  await azQuiet(
    `keyvault secret set --vault-name ${ctx.keyVaultName} --name copilot-client-id ` +
      `--value "${app.appId}"`
  );
  await azQuiet(
    `keyvault secret set --vault-name ${ctx.keyVaultName} --name copilot-client-secret ` +
      `--value "${cred.password.replace(/"/g, '\\"')}"`
  );
}

export async function deployCopilot(ctx: DeployContext): Promise<void> {
  const appName = naming.copilotAppName(ctx.customerSlug);
  const tag = IMAGE_TAGS['orca-copilot'] || 'rc-latest';
  const image = `${ctx.acrLoginServer}/orca-copilot:${tag}`;

  const entraStep = log.spinner(`Entra app for ${appName}`);
  await ensureCopilotEntraApp(ctx);
  entraStep.succeed(`  Entra app for ${appName} (${ctx.copilotEntraAppId})`);

  const s = log.spinner(`Creating ${appName} Container App`);

  // Plain env vars. Bot Framework Agents SDK (@microsoft/agents-hosting)
  // reads ONLY camelCase env vars in `loadAuthConfigFromEnv()`:
  //   clientId, tenantId, clientSecret, FICClientId, certPemFile, ...
  // The legacy MICROSOFT_APP_* / MicrosoftApp* names are NOT read by the SDK.
  // Setting AZURE_CLIENT_ID at the bot also bleeds into DefaultAzureCredential
  // and pushes the SDK down the managed-identity fallback path. See
  // CL-ORCAHQ-0111 (revised 2026-05-05) for the full diagnostic chain.
  const plainEnvVars = [
    'NODE_ENV=production',
    'DEV_MODE=false',
    'PORT=3978',
    'APPINSIGHTS_ENABLE_REQUEST_BODY=false',
    `clientId=${ctx.copilotEntraAppId}`,
    `tenantId=${ctx.tenantId}`,
    `KEY_VAULT_NAME=${ctx.keyVaultName}`,
    `FOUNDRY_ENDPOINT_PRIMARY=${FOUNDRY_ENDPOINT_PRIMARY}/`,
    `FOUNDRY_ENDPOINT_SECONDARY=${FOUNDRY_ENDPOINT_SWC}/`,
    `FOUNDRY_CLASSIFIER_ENDPOINT=${FOUNDRY_ENDPOINT_SWC}/`,
    'CLASSIFIER_MODEL=claude-haiku-4-5',
  ];

  if (ctx.gatewayUrl) {
    plainEnvVars.push(`MCP_GATEWAY_URL=${ctx.gatewayUrl}/mcp`);
    plainEnvVars.push(`MCP_GATEWAY_AUDIENCE=${ctx.entraAppId}`);
  }

  const existing = await az(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup}`
  );

  if (existing.exitCode === 0) {
    s.text = `Updating existing ${appName} Container App`;
    await azQuiet(
      `containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} ` +
        `--image ${image} --set-env-vars ${plainEnvVars.join(' ')}`
    );
  } else {
    await azQuiet(
      [
        `containerapp create`,
        `--name ${appName}`,
        `--resource-group ${ctx.resourceGroup}`,
        `--environment ${ctx.caEnvironment}`,
        `--image ${image}`,
        `--ingress external --target-port 3978`,
        `--min-replicas 1 --max-replicas 3`,
        `--cpu 0.5 --memory 1.0Gi`,
        `--registry-server ${ctx.acrLoginServer}`,
        `--registry-identity "${ctx.miId}"`,
        `--user-assigned "${ctx.miId}"`,
        `--env-vars ${plainEnvVars.join(' ')}`,
      ].join(' ')
    );
  }

  const fqdn = await azTsv(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--query "properties.configuration.ingress.fqdn"`
  );
  ctx.copilotFqdn = fqdn;
  ctx.copilotUrl = `https://${fqdn}`;

  // Bind KV secrets — copilot-client-secret (bot auth), heartbeat-secret (shared
  // with gateway), graph-webhook-secret (shared inbound secret).
  const kvSecrets: string[] = [
    `copilot-client-secret=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/copilot-client-secret,identityref:${ctx.miId}`,
  ];
  if (ctx.heartbeatSecret) {
    kvSecrets.push(
      `heartbeat-secret=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/heartbeat-secret,identityref:${ctx.miId}`
    );
  }
  if (ctx.graphWebhookClientState) {
    kvSecrets.push(
      `graph-webhook-client-state=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/graph-webhook-client-state,identityref:${ctx.miId}`
    );
  }
  if (ctx.credentials['app-insights-conn-string']) {
    kvSecrets.push(
      `app-insights-conn-string=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/app-insights-conn-string,identityref:${ctx.miId}`
    );
  }

  await azQuiet(
    `containerapp secret set --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--secrets ${kvSecrets.map((s) => `"${s}"`).join(' ')}`
  );

  // Full env var set with secretRefs + runtime-resolved FQDNs
  const allEnvVars = [
    ...plainEnvVars,
    'clientSecret=secretref:copilot-client-secret',
    `NOTIFICATION_ENDPOINT=${ctx.copilotUrl}/api/notifications`,
  ];
  if (ctx.heartbeatSecret) {
    allEnvVars.push('HEARTBEAT_SECRET=secretref:heartbeat-secret');
  }
  if (ctx.graphWebhookClientState) {
    allEnvVars.push('GRAPH_WEBHOOK_CLIENT_STATE=secretref:graph-webhook-client-state');
  }
  if (ctx.credentials['app-insights-conn-string']) {
    allEnvVars.push('APPINSIGHTS_CONNECTION_STRING=secretref:app-insights-conn-string');
  }

  await azQuiet(
    `containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--set-env-vars ${allEnvVars.join(' ')}`
  );

  s.succeed(`  ${appName} deployed (${fqdn})`);
  log.dim(
    '  Bot channel registration + Teams app manifest must be completed manually'
  );
}

// =============================================================================
// Governance portal — static server that proxies /gateway/* to the MCP gateway.
// Customer admin surface. Locked to ORCA.Founder role via gateway auth (the
// portal itself is just a proxy + SPA).
// =============================================================================

export async function deployGovernancePortal(ctx: DeployContext): Promise<void> {
  const appName = naming.governancePortalAppName(ctx.customerSlug);
  const tag = IMAGE_TAGS['orca-governance-portal'] || 'rc-latest';
  const image = `${ctx.acrLoginServer}/orca-governance-portal:${tag}`;

  const s = log.spinner(`Creating ${appName} Container App`);

  const plainEnvVars = [
    'NODE_ENV=production',
    'DEV_MODE=false',
    'PORT=3000',
    'APPINSIGHTS_ENABLE_REQUEST_BODY=false',
    `AZURE_CLIENT_ID=${ctx.miClientId}`,
    `KEY_VAULT_NAME=${ctx.keyVaultName}`,
    `TENANT_ID=${ctx.tenantId}`,
    `CLIENT_ID=${ctx.entraAppId}`,
    'ALLOWED_ROLES=ORCA.Founder',
  ];
  if (ctx.gatewayUrl) {
    plainEnvVars.push(`GATEWAY_URL=${ctx.gatewayUrl}`);
  }

  const existing = await az(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup}`
  );

  if (existing.exitCode === 0) {
    s.text = `Updating existing ${appName} Container App`;
    await azQuiet(
      `containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} ` +
        `--image ${image} --set-env-vars ${plainEnvVars.join(' ')}`
    );
  } else {
    await azQuiet(
      [
        `containerapp create`,
        `--name ${appName}`,
        `--resource-group ${ctx.resourceGroup}`,
        `--environment ${ctx.caEnvironment}`,
        `--image ${image}`,
        `--ingress external --target-port 3000`,
        `--min-replicas 1 --max-replicas 2`,
        `--cpu 0.25 --memory 0.5Gi`,
        `--registry-server ${ctx.acrLoginServer}`,
        `--registry-identity "${ctx.miId}"`,
        `--user-assigned "${ctx.miId}"`,
        `--env-vars ${plainEnvVars.join(' ')}`,
      ].join(' ')
    );
  }

  const fqdn = await azTsv(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--query "properties.configuration.ingress.fqdn"`
  );
  ctx.governancePortalFqdn = fqdn;
  ctx.governancePortalUrl = `https://${fqdn}`;

  // Bind entra-client-secret if portal needs OAuth (future-proof)
  const kvSecrets: string[] = [
    `entra-client-secret=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/entra-client-secret,identityref:${ctx.miId}`,
  ];
  await azQuiet(
    `containerapp secret set --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--secrets ${kvSecrets.map((s) => `"${s}"`).join(' ')}`
  );

  const allEnvVars = [...plainEnvVars, 'CLIENT_SECRET=secretref:entra-client-secret'];
  await azQuiet(
    `containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--set-env-vars ${allEnvVars.join(' ')}`
  );

  s.succeed(`  ${appName} deployed (${fqdn})`);
}

// =============================================================================
// Governance connector — internal MCP server used by the governance portal to
// invoke Founder-gated ops (approvals, gardener invokes, etc.). Internal
// ingress only; no KV secrets. Shares the gateway UAMI (ctx.miId) for ACR pull.
// =============================================================================

export async function deployGovernanceConnector(ctx: DeployContext): Promise<void> {
  const appName = naming.governanceConnectorAppName(ctx.customerSlug);
  const tag = IMAGE_TAGS['orca-governance-connector'] || 'rc-latest';
  const image = `${ctx.acrLoginServer}/orca-governance-connector:${tag}`;

  const s = log.spinner(`Creating ${appName} Container App`);

  const plainEnvVars = [
    'NODE_ENV=production',
    'DEV_MODE=false',
    'PORT=3000',
    'APPINSIGHTS_ENABLE_REQUEST_BODY=false',
    `TENANT_ID=${ctx.tenantId}`,
    `ENTRA_TENANT_ID=${ctx.tenantId}`,
    `AZURE_CLIENT_ID=${ctx.miClientId}`,
    'REQUIRE_ROLE=ORCA.Founder',
  ];
  if (ctx.gatewayUrl) {
    plainEnvVars.push(`GATEWAY_URL=${ctx.gatewayUrl}`);
  }

  const existing = await az(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup}`
  );

  if (existing.exitCode === 0) {
    s.text = `Updating existing ${appName} Container App`;
    await azQuiet(
      `containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} ` +
        `--image ${image} --set-env-vars ${plainEnvVars.join(' ')}`
    );
  } else {
    await azQuiet(
      [
        `containerapp create`,
        `--name ${appName}`,
        `--resource-group ${ctx.resourceGroup}`,
        `--environment ${ctx.caEnvironment}`,
        `--image ${image}`,
        `--ingress internal --target-port 3000`,
        `--min-replicas 1 --max-replicas 1`,
        `--cpu 0.25 --memory 0.5Gi`,
        `--registry-server ${ctx.acrLoginServer}`,
        `--registry-identity "${ctx.miId}"`,
        `--user-assigned "${ctx.miId}"`,
        `--env-vars ${plainEnvVars.join(' ')}`,
      ].join(' ')
    );
  }

  const fqdn = await azTsv(
    `containerapp show --name ${appName} --resource-group ${ctx.resourceGroup} ` +
      `--query "properties.configuration.ingress.fqdn"`
  );
  ctx.governanceConnectorFqdn = fqdn;
  ctx.governanceConnectorUrl = `https://${fqdn}`;

  s.succeed(`  ${appName} deployed (${fqdn})`);
}

// =============================================================================
// Orchestrator — run the core product deploys in dependency order.
// =============================================================================

export async function deployCoreProduct(ctx: DeployContext): Promise<void> {
  log.heading('  Core ORCA Product — Container Apps');

  // 1. Licence service (optional — ORCA HQ endpoint is already set in ctx)
  //    Only deploy locally if the customer wants an air-gapped licence endpoint.
  //    Default is skip — ORCA HQ endpoint in licenses.ts is fine for MVP.
  //    Uncomment when customer opts into local licence service:
  //    await deployLicenseService(ctx);

  // 2. Gateway — needs qdrantInternalUrl, eligibilityGroupOid, entraAppId.
  //    First pass produces ctx.gatewayFqdn; if a custom domain was requested,
  //    we bind it immediately so every downstream deploy uses the custom URL.
  await deployGateway(ctx);

  // 2b. Optional — bind custom domain (CNAME + managed cert). Flips
  //     ctx.gatewayUrl to https://<custom> when successful. If the operator
  //     hasn't set up DNS yet they can skip at the prompt and re-run later.
  if (ctx.customGatewayDomain) {
    await bindCustomGatewayDomain(ctx);
    // Re-deploy gateway so its GATEWAY_URL env var matches the custom host.
    if (ctx.customGatewayDomainBound) {
      await deployGateway(ctx);
    }
  }

  // 3. Copilot — needs gatewayUrl so MCP_GATEWAY_URL can be wired
  await deployCopilot(ctx);

  // 4. Re-deploy gateway to pick up COPILOT_URL (fast idempotent update)
  await deployGateway(ctx);

  // 5. Governance connector — internal MCP server, needs gatewayUrl
  await deployGovernanceConnector(ctx);

  // 6. Governance portal — needs gatewayUrl (and optionally connector URL)
  await deployGovernancePortal(ctx);
}
