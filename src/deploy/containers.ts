import type { DeployContext } from '../types.js';
import { azQuiet, azTsv } from '../utils/az.js';
import { IMAGE_TAGS, ORCA_HQ_ACR } from '../utils/config.js';
import * as naming from '../utils/naming.js';
import * as log from '../utils/log.js';

export async function createContainerApps(ctx: DeployContext): Promise<void> {
  for (const connector of ctx.selectedConnectors) {
    const appName = naming.connectorAppName(connector.slug);
    const tag = IMAGE_TAGS[connector.image] || 'rc-latest';
    const image = `${ctx.acrLoginServer}/${connector.image}:${tag}`;

    const s = log.spinner(`Creating ${connector.name} Container App`);

    // Build env vars — shared
    const envVars = [
      'DEV_MODE=false',
      'PORT=3000',
      'NODE_ENV=production',
      'APPINSIGHTS_ENABLE_REQUEST_BODY=false',
      `TENANT_ID=${ctx.tenantId}`,
      `CLIENT_ID=${ctx.entraAppId}`,
      'CLIENT_SECRET=secretref:entra-client-secret',
      'JWT_SIGNING_KEY=secretref:connector-jwt-key',
      'ALLOWED_ROLES=ORCA.Founder,ORCA.Director',
      // CONNECTOR_URL set after creation (need FQDN)
    ];

    // Add connector-specific secret refs
    for (const secret of connector.secrets) {
      if (ctx.credentials[secret.kv]) {
        envVars.push(`${secret.env}=secretref:${secret.kv}`);
      }
    }

    // Create the Container App
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
      `--env-vars ${envVars.join(' ')}`,
    ].join(' '));

    // Get the FQDN
    const fqdn = await azTsv(`containerapp show --name ${appName} --resource-group ${ctx.resourceGroup} --query "properties.configuration.ingress.fqdn"`);
    ctx.connectorFqdns[connector.slug] = fqdn;

    // Now set KV-referenced secrets on the Container App
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

    await azQuiet(`containerapp secret set --name ${appName} --resource-group ${ctx.resourceGroup} --secrets ${kvSecrets.map(s => `"${s}"`).join(' ')}`);

    // Update with CONNECTOR_URL now that we have the FQDN
    const allEnvVars = [...envVars, `CONNECTOR_URL=https://${fqdn}`];
    await azQuiet(`containerapp update --name ${appName} --resource-group ${ctx.resourceGroup} --set-env-vars ${allEnvVars.join(' ')}`);

    s.succeed(`  ${connector.name} deployed (${fqdn})`);
  }
}
