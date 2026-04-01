import type { DeployContext } from '../types.js';
import { az, azQuiet, azTsv } from '../utils/az.js';
import { IMAGE_TAGS, ORCA_HQ_ACR } from '../utils/config.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createContainerApps(ctx: DeployContext): Promise<void> {
  for (const connector of ctx.selectedConnectors) {
    const appName = naming.connectorAppName(connector.slug);
    const tag = IMAGE_TAGS[connector.image] || 'rc-latest';
    const image = `${ctx.acrLoginServer}/${connector.image}:${tag}`;

    const s = log.spinner(`Creating ${connector.name} Container App`);

    // Step 1: Plain env vars (no secret refs) — safe for create or update
    const plainEnvVars = [
      'DEV_MODE=false',
      'PORT=3000',
      'NODE_ENV=production',
      'APPINSIGHTS_ENABLE_REQUEST_BODY=false',
      `TENANT_ID=${ctx.tenantId}`,
      `CLIENT_ID=${ctx.entraAppId}`,
      'ALLOWED_ROLES=ORCA.Founder,ORCA.Director',
    ];

    if (ctx.licenseServiceEndpoint) {
      plainEnvVars.push(`ORCA_LICENSE_ENDPOINT=${ctx.licenseServiceEndpoint}`);
    }

    // Check if the container app already exists
    const existing = await az(`containerapp show --name ${appName} --resource-group ${ctx.resourceGroup}`);
    if (existing.exitCode === 0) {
      s.text = `Updating existing ${connector.name} Container App`;
      await azQuiet(`containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} --image ${image} --set-env-vars ${plainEnvVars.join(' ')}`);
    } else {
      await azQuiet([
        `containerapp create`,
        `--name ${appName}`,
        `--resource-group ${ctx.resourceGroup}`,
        `--environment ${ctx.caEnvironment}`,
        `--image ${image}`,
        `--ingress external --target-port 3000`,
        `--min-replicas 1 --max-replicas 3`,
        `--cpu 0.25 --memory 0.5Gi`,
        `--registry-server ${ctx.acrLoginServer}`,
        `--registry-identity "${ctx.miId}"`,
        `--user-assigned "${ctx.miId}"`,
        `--env-vars ${plainEnvVars.join(' ')}`,
      ].join(' '));
    }

    // Step 2: Get the FQDN
    const fqdn = await azTsv(`containerapp show --name ${appName} --resource-group ${ctx.resourceGroup} --query "properties.configuration.ingress.fqdn"`);
    ctx.connectorFqdns[connector.slug] = fqdn;

    // Step 3: Bind KV secrets to the container app (must happen BEFORE env vars reference them)
    const kvSecrets = [
      `entra-client-secret=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/entra-client-secret,identityref:${ctx.miId}`,
      `connector-jwt-key=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/connector-jwt-key,identityref:${ctx.miId}`,
    ];
    for (const secret of connector.secrets) {
      if (ctx.credentials[secret.kv]) {
        kvSecrets.push(
          `${secret.kv}=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/${secret.kv},identityref:${ctx.miId}`
        );
      }
    }
    if (ctx.licenseTokens[connector.slug]) {
      kvSecrets.push(
        `orca-license-${connector.slug}=keyvaultref:https://${ctx.keyVaultName}.vault.azure.net/secrets/orca-license-${connector.slug},identityref:${ctx.miId}`
      );
    }

    await azQuiet(`containerapp secret set --name ${appName} --resource-group ${ctx.resourceGroup} --secrets ${kvSecrets.map(s => `"${s}"`).join(' ')}`);

    // Step 4: Now set the full env vars including secret refs (secrets are bound, refs will resolve)
    const allEnvVars = [
      ...plainEnvVars,
      'CLIENT_SECRET=secretref:entra-client-secret',
      'JWT_SIGNING_KEY=secretref:connector-jwt-key',
      `CONNECTOR_URL=https://${fqdn}`,
    ];
    for (const secret of connector.secrets) {
      if (ctx.credentials[secret.kv]) {
        allEnvVars.push(`${secret.env}=secretref:${secret.kv}`);
      }
    }
    if (ctx.licenseTokens[connector.slug]) {
      allEnvVars.push(`ORCA_LICENSE_TOKEN=secretref:orca-license-${connector.slug}`);
    }

    await azQuiet(`containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} --set-env-vars ${allEnvVars.join(' ')}`);

    s.succeed(`  ${connector.name} deployed (${fqdn})`);
  }
}
